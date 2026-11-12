// waku-runner: runs one Logos Messaging (Waku) node from upstream's liblogosdelivery
// as a plain process, so it can be started from an adb shell or as a child process of
// an app, the same way the blockchain node is run.
//
// It only drives the library's public C API (library/liblogosdelivery.h and the
// generated typed helpers): create the node from a JSON config file, start it, print
// its identity, then print a status line (connection status, connected peers, memory
// and a few relay/traffic metrics) at a fixed interval until it is told to stop.
// Optionally it subscribes to one content topic and publishes a small test message to
// it at an interval, to prove that messages flow. On SIGINT/SIGTERM it stops and
// destroys the node before exiting.
//
// usage: waku-runner <config.json> [--duration SEC] [--status-every SEC]
//                    [--topic CONTENT_TOPIC] [--send-every SEC]
#include "liblogosdelivery.h"

#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t g_stop = 0;
static void on_signal(int sig) { (void)sig; g_stop = 1; }

static void logf_(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void logf_(const char *fmt, ...) {
    char ts[32];
    time_t now = time(NULL);
    struct tm tm;
    gmtime_r(&now, &tm);
    strftime(ts, sizeof ts, "%Y-%m-%dT%H:%M:%SZ", &tm);
    va_list ap;
    va_start(ap, fmt);
    flockfile(stdout);
    printf("%s [runner] ", ts);
    vprintf(fmt, ap);
    putchar('\n');
    funlockfile(stdout);
    va_end(ap);
}

// ---- synchronous wrapper around the asynchronous reply callbacks ----------------

typedef struct {
    pthread_mutex_t mu;
    pthread_cond_t cv;
    int done;
    int err;
    char *text;  // reply or error message, owned
} reply_t;

static void reply_init(reply_t *r) {
    pthread_mutex_init(&r->mu, NULL);
    pthread_cond_init(&r->cv, NULL);
    r->done = 0;
    r->err = 0;
    r->text = NULL;
}

static void reply_free(reply_t *r) {
    free(r->text);
    pthread_mutex_destroy(&r->mu);
    pthread_cond_destroy(&r->cv);
}

// Every string-returning call shares this reply shape.
static void on_reply(int errCode, const char *const *reply, const char *errMsg, void *userData) {
    reply_t *r = (reply_t *)userData;
    pthread_mutex_lock(&r->mu);
    r->err = errCode;
    const char *s = errCode == RET_OK ? (reply && *reply ? *reply : "") : (errMsg ? errMsg : "unknown error");
    r->text = strdup(s);
    r->done = 1;
    pthread_cond_signal(&r->cv);
    pthread_mutex_unlock(&r->mu);
}

// Returns 0 on success, -1 on error, -2 on timeout. A timed-out reply_t is leaked on
// purpose: the library may still call back into it later.
static int reply_wait(reply_t *r, int timeout_ms) {
    struct timespec dl;
    clock_gettime(CLOCK_REALTIME, &dl);
    dl.tv_sec += timeout_ms / 1000;
    dl.tv_nsec += (long)(timeout_ms % 1000) * 1000000L;
    if (dl.tv_nsec >= 1000000000L) { dl.tv_sec++; dl.tv_nsec -= 1000000000L; }
    pthread_mutex_lock(&r->mu);
    while (!r->done) {
        if (pthread_cond_timedwait(&r->cv, &r->mu, &dl) == ETIMEDOUT) break;
    }
    int done = r->done, err = r->err;
    pthread_mutex_unlock(&r->mu);
    if (!done) return -2;
    return err == RET_OK ? 0 : -1;
}

// Runs one typed-helper call and waits for its reply. `call` must pass on_reply and r.
#define CALL_SYNC(label, timeout_ms, out_text, call)                                  \
    ({                                                                                \
        reply_t *r = malloc(sizeof(reply_t));                                         \
        reply_init(r);                                                                \
        int rc_ = (call);                                                             \
        int w_ = rc_ == 0 ? reply_wait(r, (timeout_ms)) : -1;                         \
        if (w_ == -2) {                                                               \
            logf_("%s: no reply after %d ms", (label), (timeout_ms));                 \
        } else {                                                                      \
            if (w_ != 0) logf_("%s failed: %s", (label), r->text ? r->text : "(submit failed)"); \
            if ((out_text) != NULL) *(char **)(out_text) = (w_ == 0 && r->text) ? strdup(r->text) : NULL; \
            reply_free(r);                                                            \
            free(r);                                                                  \
        }                                                                             \
        w_;                                                                           \
    })

// ---- node creation --------------------------------------------------------------

static reply_t g_create;
static LogosDeliveryCtx *g_ctx = NULL;

static void on_created(int errCode, LogosDeliveryCtx *ctx, const char *errMsg, void *userData) {
    (void)userData;
    pthread_mutex_lock(&g_create.mu);
    g_create.err = errCode;
    if (errCode == RET_OK) g_ctx = ctx;
    else g_create.text = strdup(errMsg ? errMsg : "unknown error");
    g_create.done = 1;
    pthread_cond_signal(&g_create.cv);
    pthread_mutex_unlock(&g_create.mu);
}

// ---- events ---------------------------------------------------------------------

static volatile long g_received = 0, g_propagated = 0, g_sent = 0, g_send_errors = 0;

static void on_event(int ret, const char *msg, size_t len, void *userData) {
    const char *name = (const char *)userData;
    if (ret != RET_OK || msg == NULL) return;
    if (strcmp(name, "onMessageReceived") == 0) g_received++;
    else if (strcmp(name, "onMessagePropagated") == 0) g_propagated++;
    else if (strcmp(name, "onMessageSent") == 0) g_sent++;
    else if (strcmp(name, "onMessageError") == 0) g_send_errors++;
    int n = len > 1500 ? 1500 : (int)len;
    logf_("event %s: %.*s%s", name, n, msg, len > 1500 ? "..." : "");
}

// ---- helpers --------------------------------------------------------------------

static char *read_file(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc((size_t)n + 1);
    if (buf && fread(buf, 1, (size_t)n, f) != (size_t)n) { free(buf); buf = NULL; }
    if (buf) buf[n] = '\0';
    fclose(f);
    return buf;
}

static long proc_status_kb(const char *key) {
    FILE *f = fopen("/proc/self/status", "r");
    if (!f) return -1;
    char line[256];
    long v = -1;
    size_t kl = strlen(key);
    while (fgets(line, sizeof line, f)) {
        if (strncmp(line, key, kl) == 0 && line[kl] == ':') { v = atol(line + kl + 1); break; }
    }
    fclose(f);
    return v;
}

static int count_csv(const char *s) {
    if (!s || !*s) return 0;
    int n = 1;
    for (; *s; s++) if (*s == ',') n++;
    return n;
}

// Prints the Prometheus lines whose metric name starts with one of these prefixes.
static const char *k_metric_prefixes[] = {
    "libp2p_peers", "libp2p_network_bytes", "libp2p_pubsub_peers", "libp2p_gossipsub_peers_per_topic_mesh",
    "libp2p_pubsub_received_messages", "libp2p_pubsub_validation_success", "libp2p_gossipsub_received",
    "waku_connected_peers", "waku_node_messages", "waku_relay_network_bytes", "waku_peer_store_size",
    "waku_px_peers", "waku_discv5_discovered", "waku_histogram_message_size_count", NULL};

static void print_metrics(const char *text) {
    if (!text) return;
    const char *p = text;
    while (*p) {
        const char *e = strchr(p, '\n');
        size_t n = e ? (size_t)(e - p) : strlen(p);
        if (n > 0 && p[0] != '#') {
            for (const char **k = k_metric_prefixes; *k; k++) {
                size_t kl = strlen(*k);
                if (n >= kl && strncmp(p, *k, kl) == 0) { logf_("metric %.*s", (int)(n > 300 ? 300 : n), p); break; }
            }
        }
        if (!e) break;
        p = e + 1;
    }
}

static const char b64tab[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void base64(const unsigned char *in, size_t n, char *out) {
    size_t i = 0, o = 0;
    for (; i + 2 < n; i += 3) {
        unsigned v = (unsigned)in[i] << 16 | (unsigned)in[i + 1] << 8 | in[i + 2];
        out[o++] = b64tab[v >> 18 & 63]; out[o++] = b64tab[v >> 12 & 63];
        out[o++] = b64tab[v >> 6 & 63];  out[o++] = b64tab[v & 63];
    }
    if (i < n) {
        unsigned v = (unsigned)in[i] << 16 | (i + 1 < n ? (unsigned)in[i + 1] << 8 : 0);
        out[o++] = b64tab[v >> 18 & 63]; out[o++] = b64tab[v >> 12 & 63];
        out[o++] = i + 1 < n ? b64tab[v >> 6 & 63] : '=';
        out[o++] = '=';
    }
    out[o] = '\0';
}

static void print_status(const LogosDeliveryCtx *ctx, int with_metrics) {
    char *status = NULL, *peers = NULL, *metrics = NULL;
    CALL_SYNC("get_connection_status", 10000, &status,
              logosdelivery_ctx_get_connection_status(ctx, on_reply, r));
    CALL_SYNC("get_connected_peers", 10000, &peers,
              logosdelivery_ctx_waku_get_connected_peers(ctx, on_reply, r));
    logf_("status connection=%s connected_peers=%d rss_kb=%ld hwm_kb=%ld threads=%ld "
          "received=%ld sent=%ld propagated=%ld send_errors=%ld",
          status ? status : "?", count_csv(peers), proc_status_kb("VmRSS"), proc_status_kb("VmHWM"),
          proc_status_kb("Threads"), g_received, g_sent, g_propagated, g_send_errors);
    if (with_metrics) {
        CALL_SYNC("get_node_info Metrics", 10000, &metrics,
                  logosdelivery_ctx_get_node_info(ctx, "Metrics", on_reply, r));
        print_metrics(metrics);
    }
    free(status); free(peers); free(metrics);
}

static void usage(const char *argv0) {
    fprintf(stderr,
            "usage: %s <config.json> [--duration SEC] [--status-every SEC] [--topic CONTENT_TOPIC] [--send-every SEC]\n"
            "  --duration SEC      stop after SEC seconds (default 0: run until SIGINT/SIGTERM)\n"
            "  --status-every SEC  status line interval (default 30)\n"
            "  --topic TOPIC       subscribe to this content topic and log what arrives on it\n"
            "  --send-every SEC    publish a small ephemeral test message to --topic every SEC\n",
            argv0);
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (argc < 2 || argv[1][0] == '-') {
        if (argc >= 2 && strcmp(argv[1], "--version") == 0) {
            printf("%s\n", logosdelivery_version());
            return 0;
        }
        usage(argv[0]);
        return 2;
    }
    const char *config_path = argv[1];
    long duration = 0, status_every = 30, send_every = 0;
    const char *topic = NULL;
    for (int i = 2; i < argc; i++) {
        if (i + 1 >= argc) { usage(argv[0]); return 2; }
        if (strcmp(argv[i], "--duration") == 0) duration = atol(argv[++i]);
        else if (strcmp(argv[i], "--status-every") == 0) status_every = atol(argv[++i]);
        else if (strcmp(argv[i], "--topic") == 0) topic = argv[++i];
        else if (strcmp(argv[i], "--send-every") == 0) send_every = atol(argv[++i]);
        else { usage(argv[0]); return 2; }
    }
    if (status_every <= 0) status_every = 30;
    if (send_every > 0 && !topic) { fprintf(stderr, "--send-every needs --topic\n"); return 2; }

    char *config = read_file(config_path);
    if (!config) { fprintf(stderr, "cannot read %s: %s\n", config_path, strerror(errno)); return 2; }

    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    logf_("liblogosdelivery %s, pid %d", logosdelivery_version(), (int)getpid());
    // not printed: it can hold the node's private key (nodekey)
    logf_("config %s (%zu bytes)", config_path, strlen(config));

    reply_init(&g_create);
    if (logosdelivery_ctx_create(config, on_created, NULL) != 0) { logf_("create_node: submit failed"); return 1; }
    if (reply_wait(&g_create, 60000) != 0 || g_ctx == NULL) {
        logf_("create_node failed: %s", g_create.text ? g_create.text : "timeout");
        return 1;
    }
    LogosDeliveryCtx *ctx = g_ctx;
    logf_("node created");

    static const char *events[] = {"onConnectionStatusChange", "onMessageReceived", "onMessageSent",
                                   "onMessagePropagated", "onMessageError", NULL};
    for (const char **e = events; *e; e++)
        if (logosdelivery_add_event_listener(ctx->ptr, *e, on_event, (void *)*e) == 0)
            logf_("could not register listener %s", *e);

    if (CALL_SYNC("start_node", 120000, NULL, logosdelivery_ctx_start_node(ctx, on_reply, r)) != 0) {
        logosdelivery_ctx_destroy(ctx);
        return 1;
    }
    logf_("node started");

    static const char *infos[] = {"Version", "MyPeerId", "MyMultiaddresses", "MyBoundPorts", "MyENR",
                                  "MaxMessageSize", NULL};
    for (const char **id = infos; *id; id++) {
        char *v = NULL;
        CALL_SYNC("get_node_info", 10000, &v, logosdelivery_ctx_get_node_info(ctx, *id, on_reply, r));
        logf_("info %s: %s", *id, v ? v : "?");
        free(v);
    }

    if (topic) {
        if (CALL_SYNC("subscribe", 30000, NULL, logosdelivery_ctx_subscribe(ctx, topic, on_reply, r)) == 0)
            logf_("subscribed to %s", topic);
    }

    time_t start = time(NULL), next_status = start + 5, next_send = send_every > 0 ? start + 20 : 0;
    long tick = 0, sent_count = 0;
    while (!g_stop) {
        time_t now = time(NULL);
        if (duration > 0 && now - start >= duration) { logf_("duration reached"); break; }
        if (now >= next_status) {
            print_status(ctx, tick % 2 == 0);
            tick++;
            next_status = now + status_every;
        }
        if (next_send && now >= next_send) {
            char text[160], b64[256], json[1024];
            int n = snprintf(text, sizeof text, "waku-runner test %ld from pid %d at %ld", ++sent_count,
                             (int)getpid(), (long)now);
            base64((const unsigned char *)text, (size_t)n, b64);
            snprintf(json, sizeof json, "{\"contentTopic\":\"%s\",\"payload\":\"%s\",\"ephemeral\":true}", topic, b64);
            char *req = NULL;
            if (CALL_SYNC("send", 30000, &req, logosdelivery_ctx_send(ctx, json, on_reply, r)) == 0)
                logf_("send #%ld queued, request %s", sent_count, req ? req : "?");
            free(req);
            next_send = now + send_every;
        }
        sleep(1);
    }

    logf_("stopping");
    print_status(ctx, 1);
    if (topic) CALL_SYNC("unsubscribe", 10000, NULL, logosdelivery_ctx_unsubscribe(ctx, topic, on_reply, r));
    CALL_SYNC("stop_node", 15000, NULL, logosdelivery_ctx_stop_node(ctx, on_reply, r));
    logosdelivery_ctx_destroy(ctx);
    logf_("stopped");
    free(config);
    return 0;
}
