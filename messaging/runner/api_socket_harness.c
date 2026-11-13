// api_socket_harness: api_socket.h with a stand-in for the messaging library, for tests on a
// computer (test_api_socket.py, and the app's tests/messaging_socket_test.py). Not shipped.
//
//   api_socket_harness <socket path>          serve until killed; prints "ready" once listening
//   api_socket_harness --check <socket path>  only try to open the socket; exit 0 if it opened
//
// The stand-in: subscribe works except for topics containing "/fail/"; send returns request ids
// req-1, req-2, ... and, 50 ms later, reports the message propagated and sent and delivers it back
// as received (a node that is subscribed to its own topic); a send to a topic containing "fail" is
// reported as an error instead, with a message that needs escaping. connection status: "Connected".
#include "api_socket.h"

#include <signal.h>
#include <time.h>

static int g_next = 0;
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;

static int st_subscribe(const char *topic, char **err) {
    if (strstr(topic, "/fail/")) { *err = strdup("stand-in: \"no\" to this topic"); return -1; }
    return 0;
}
static int st_unsubscribe(const char *topic, char **err) { (void)topic; (void)err; return 0; }
static char *st_status(void) { return strdup("Connected"); }
static void st_log(const char *line) { fprintf(stderr, "[harness] %s\n", line); }

typedef struct { int n; char *json; } later_t;

static void emit(const char *name, const char *json) { api_on_event(name, json, strlen(json)); }

static void *later(void *arg) {
    later_t *l = arg;
    struct timespec ts = {0, 50 * 1000000L};
    nanosleep(&ts, NULL);
    char *payload = api_json_str(l->json, strlen(l->json), "payload");
    char *topic = api_json_str(l->json, strlen(l->json), "contentTopic");
    char ev[8192];
    if (topic && strstr(topic, "fail")) {
        snprintf(ev, sizeof ev, "{\"eventType\":\"message_error\",\"requestId\":\"req-%d\",\"messageHash\":\"0x%064d\",\"error\":\"stand-in: \\\"bad\\\" \\\\ thing\"}", l->n, l->n);
        emit("onMessageError", ev);
    } else {
        snprintf(ev, sizeof ev, "{\"eventType\":\"message_propagated\",\"requestId\":\"req-%d\",\"messageHash\":\"0x%064d\"}", l->n, l->n);
        emit("onMessagePropagated", ev);
        snprintf(ev, sizeof ev, "{\"eventType\":\"message_sent\",\"requestId\":\"req-%d\",\"messageHash\":\"0x%064d\"}", l->n, l->n);
        emit("onMessageSent", ev);
        if (payload && topic) {
            snprintf(ev, sizeof ev, "{\"eventType\":\"message_received\",\"messageHash\":\"0x%064d\",\"message\":{\"payload\":\"%s\","
                     "\"contentTopic\":\"%s\",\"version\":0,\"timestamp\":1700000000000000000,\"ephemeral\":false,\"meta\":\"\",\"proof\":\"\"},"
                     "\"source\":\"live\"}", l->n, payload, topic);
            emit("onMessageReceived", ev);
        }
    }
    free(payload); free(topic); free(l->json); free(l);
    return NULL;
}

static int st_send(const char *json, char **rid, char **err) {
    (void)err;
    pthread_mutex_lock(&g_mu);
    int n = ++g_next;
    pthread_mutex_unlock(&g_mu);
    char buf[32];
    snprintf(buf, sizeof buf, n % 2 ? "req-%d" : "\"req-%d\"", n);   // quoted every other time, as the library may
    *rid = strdup(buf);
    later_t *l = malloc(sizeof *l);
    l->n = n; l->json = strdup(json);
    pthread_t t;
    pthread_create(&t, NULL, later, l);
    pthread_detach(t);
    return 0;
}

static const api_backend_t k_stand_in = {st_subscribe, st_unsubscribe, st_send, st_status, st_log};

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (argc == 3 && strcmp(argv[1], "--check") == 0) return api_start(argv[2], &k_stand_in) == 0 ? 0 : 3;
    if (argc != 2) { fprintf(stderr, "usage: %s [--check] <socket path>\n", argv[0]); return 2; }
    if (api_start(argv[1], &k_stand_in) != 0) return 3;
    printf("ready\n");
    for (;;) pause();
}
