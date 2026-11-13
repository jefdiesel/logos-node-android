// api_socket.h: the runner's own local API, HTTP/1.1 on a Unix domain socket.
//
// The library's REST server listens on TCP, and on a phone every installed app can connect to
// 127.0.0.1. So the runner turns REST off and serves the few calls the wallet makes on a socket
// file instead, in a directory only this user can enter:
//
//   GET    /health                              {"nodeHealth":"Ready","connectionStatus":"..."}
//   GET    /messaging/v1/subscriptions          ["topic", ...] (sorted)
//   POST   /messaging/v1/subscriptions          ["topic", ...]  subscribe
//   DELETE /messaging/v1/subscriptions          ["topic", ...]  unsubscribe
//   POST   /messaging/v1/messages               {"payload":..,"contentTopic":..,"ephemeral":..} -> {"requestId":".."}
//   GET    /messaging/v1/events/received        [{"seq":N, <the message_received event>}, ...], then cleared
//   GET    /messaging/v1/events/send/<id>       {"requestId":"..","events":[{"kind":"sent"},..]}, then removed
//
// The same paths and answers as the library's REST API (rest/messaging_api at logos-delivery
// 57e04dc), including evict-after-poll, so a client changes only its transport. Received
// messages come from the library's onMessageReceived events, send status from its onMessage*
// events, as the REST API's own buffers do.
//
// Header-only (static functions), included by waku_runner.c and by api_socket_harness.c, which
// runs it with a stand-in library for tests.
#ifndef API_SOCKET_H
#define API_SOCKET_H

#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0   // (macOS, for the test harness; the runner ignores SIGPIPE anyway)
#endif

// What the runner provides. Each returns 0 on success; *err (malloc'd, may stay NULL) on failure.
typedef struct {
    int (*subscribe)(const char *topic, char **err);
    int (*unsubscribe)(const char *topic, char **err);
    int (*send)(const char *message_json, char **request_id, char **err);
    char *(*connection_status)(void);  // malloc'd, or NULL if unknown
    void (*log)(const char *line);
} api_backend_t;

#define API_MAX_RECEIVED 256      // received messages kept between polls (upstream keeps 50)
// ...and at most this many bytes of them (their JSON records), so one poll's answer always fits what
// the client reads in one go (server.py reads up to 16 MiB over the socket, 4 MiB over TCP): a client that cut an answer short would
// lose the whole batch, which this side has already dropped. A message on logos.test is at most
// 150 KiB (about 200 KB as base64 JSON), so this holds at least 10 of the largest.
#define API_MAX_RECEIVED_BYTES (2 * 1024 * 1024)
#define API_MAX_SENDS 256         // request ids with send events kept between polls
#define API_MAX_TOPICS 64
#define API_MAX_TOPIC_LEN 256
#define API_MAX_HEADER 16384
#define API_MAX_BODY (1024 * 1024)
#define API_MAX_CONNECTIONS 16
#define API_IO_TIMEOUT_S 15

static const api_backend_t *api_b = NULL;
static pthread_mutex_t api_mu = PTHREAD_MUTEX_INITIALIZER;
static int api_fd = -1;
static int api_open_connections = 0;

static char *api_received[API_MAX_RECEIVED];
static int api_received_n = 0;
static size_t api_received_bytes = 0;    // the records' lengths plus one comma each
static unsigned long long api_seq = 0;

typedef struct {
    char id[128];
    char *events;     // JSON objects joined by ",", malloc'd
} api_send_t;
static api_send_t api_sends[API_MAX_SENDS];
static int api_sends_n = 0;

static char *api_topics[API_MAX_TOPICS];
static int api_topics_n = 0;

static void api_logf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void api_logf(const char *fmt, ...) {
    char line[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof line, fmt, ap);
    va_end(ap);
    if (api_b && api_b->log) api_b->log(line);
}

// ---- small growable string ------------------------------------------------------------------

typedef struct { char *s; size_t n, cap; int oom; } api_buf_t;

static void api_put(api_buf_t *b, const char *s, size_t n) {
    if (b->oom) return;
    if (b->n + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : 256;
        while (cap < b->n + n + 1) cap *= 2;
        char *p = realloc(b->s, cap);
        if (!p) { b->oom = 1; return; }
        b->s = p; b->cap = cap;
    }
    memcpy(b->s + b->n, s, n);
    b->n += n;
    b->s[b->n] = '\0';
}
static void api_puts(api_buf_t *b, const char *s) { api_put(b, s, strlen(s)); }

// ---- JSON bits --------------------------------------------------------------------------------

// A topic as this API accepts it: printable ASCII, no quote, backslash or space, 1..256 bytes.
static int api_topic_ok(const char *s, size_t n) {
    if (n == 0 || n > API_MAX_TOPIC_LEN) return 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c <= 0x20 || c >= 0x7f || c == '"' || c == '\\') return 0;
    }
    return 1;
}

static const char *api_ws(const char *p, const char *end) {
    while (p < end && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) p++;
    return p;
}

// Parses ["a","b",...] (no escapes) into out[] (malloc'd strings). Returns the count, or -1.
static int api_parse_topics(const char *body, size_t len, char **out, int max) {
    const char *p = body, *end = body + len;
    int n = 0;
    p = api_ws(p, end);
    if (p >= end || *p++ != '[') return -1;
    p = api_ws(p, end);
    if (p < end && *p == ']') return api_ws(p + 1, end) == end ? 0 : -1;
    for (;;) {
        p = api_ws(p, end);
        if (p >= end || *p++ != '"') goto bad;
        const char *s = p;
        while (p < end && *p != '"' && *p != '\\') p++;
        if (p >= end || *p != '"' || !api_topic_ok(s, (size_t)(p - s)) || n >= max) goto bad;
        out[n] = strndup(s, (size_t)(p - s));
        if (!out[n]) goto bad;
        n++;
        p = api_ws(p + 1, end);
        if (p < end && *p == ',') { p++; continue; }
        if (p < end && *p == ']' && api_ws(p + 1, end) == end) return n;
        goto bad;
    }
bad:
    for (int i = 0; i < n; i++) free(out[i]);
    return -1;
}

// Finds "key":"value" in a JSON object written by the library and returns the raw value (between
// the quotes, escapes kept as they are, so it can be written back as a JSON string), or NULL.
static char *api_json_str(const char *json, size_t len, const char *key) {
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    size_t pl = strlen(pat);
    const char *end = json + len;
    for (const char *p = json; p + pl <= end; p++) {
        if (memcmp(p, pat, pl) != 0) continue;
        const char *q = api_ws(p + pl, end);
        if (q >= end || *q != ':') continue;
        q = api_ws(q + 1, end);
        if (q >= end || *q != '"') continue;
        const char *s = ++q;
        while (q < end && *q != '"') q += (*q == '\\' && q + 1 < end) ? 2 : 1;
        if (q >= end) return NULL;
        return strndup(s, (size_t)(q - s));
    }
    return NULL;
}

static int api_id_ok(const char *s) {
    size_t n = strlen(s);
    if (n == 0 || n >= sizeof(((api_send_t *)0)->id)) return 0;
    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == ':'))
            return 0;
    }
    return 1;
}

// ---- events from the library ----------------------------------------------------------------

// Called from the runner's event callback for every event. Never blocks for long.
static void api_on_event(const char *name, const char *msg, size_t len) {
    if (!msg || len == 0) return;
    if (strcmp(name, "onMessageReceived") == 0) {
        const char *p = api_ws(msg, msg + len);
        if (p >= msg + len || *p != '{') return;
        size_t rest = len - (size_t)(p + 1 - msg);
        pthread_mutex_lock(&api_mu);
        api_seq++;
        char head[48];
        int hl = snprintf(head, sizeof head, "{\"seq\":%llu,", api_seq);
        char *rec = malloc((size_t)hl + rest + 1);
        if (rec) {
            memcpy(rec, head, (size_t)hl);
            memcpy(rec + hl, p + 1, rest);
            rec[(size_t)hl + rest] = '\0';
            // `{"seq":N,}` if the event was an empty object: not a message, drop it
            size_t need = (size_t)hl + rest + 1;
            if (rest > 0 && rec[hl] != '}' && need <= API_MAX_RECEIVED_BYTES) {
                // full (by count or by bytes): the oldest go, as upstream; the gap shows in `seq`
                while (api_received_n > 0 && (api_received_n == API_MAX_RECEIVED || api_received_bytes + need > API_MAX_RECEIVED_BYTES)) {
                    api_received_bytes -= strlen(api_received[0]) + 1;
                    free(api_received[0]);
                    memmove(api_received, api_received + 1, sizeof(char *) * (size_t)(api_received_n - 1));
                    api_received_n--;
                }
                api_received[api_received_n++] = rec;
                api_received_bytes += need;
            } else {
                free(rec);
            }
        }
        pthread_mutex_unlock(&api_mu);
        return;
    }
    const char *kind = strcmp(name, "onMessageSent") == 0 ? "sent"
                     : strcmp(name, "onMessagePropagated") == 0 ? "propagated"
                     : strcmp(name, "onMessageError") == 0 ? "error"
                     : strcmp(name, "onMessageQueued") == 0 ? "queued" : NULL;
    if (!kind) return;
    char *id = api_json_str(msg, len, "requestId");
    if (!id || !api_id_ok(id)) { free(id); return; }
    char *errtxt = strcmp(kind, "error") == 0 ? api_json_str(msg, len, "error") : NULL;
    api_buf_t ev = {0};
    api_puts(&ev, "{\"kind\":\"");
    api_puts(&ev, kind);
    api_puts(&ev, "\"");
    if (errtxt) { api_puts(&ev, ",\"error\":\""); api_puts(&ev, errtxt); api_puts(&ev, "\""); }
    api_puts(&ev, "}");
    free(errtxt);
    if (ev.oom) { free(ev.s); free(id); return; }
    pthread_mutex_lock(&api_mu);
    api_send_t *s = NULL;
    for (int i = 0; i < api_sends_n; i++) if (strcmp(api_sends[i].id, id) == 0) { s = &api_sends[i]; break; }
    if (!s) {
        if (api_sends_n == API_MAX_SENDS) {                         // full: the oldest goes
            free(api_sends[0].events);
            memmove(api_sends, api_sends + 1, sizeof(api_send_t) * (API_MAX_SENDS - 1));
            api_sends_n--;
        }
        s = &api_sends[api_sends_n++];
        memset(s, 0, sizeof *s);
        snprintf(s->id, sizeof s->id, "%s", id);
    }
    size_t old = s->events ? strlen(s->events) : 0;
    char *joined = realloc(s->events, old + (old ? 1 : 0) + ev.n + 1);
    if (joined) {
        if (old) joined[old++] = ',';
        memcpy(joined + old, ev.s, ev.n + 1);
        s->events = joined;
    }
    pthread_mutex_unlock(&api_mu);
    free(ev.s);
    free(id);
}

// ---- requests -------------------------------------------------------------------------------

static void api_reply(int fd, int code, const char *body) {
    const char *reason = code == 200 ? "OK" : code == 400 ? "Bad Request" : code == 404 ? "Not Found"
                       : code == 405 ? "Method Not Allowed" : code == 413 ? "Payload Too Large"
                       : code == 503 ? "Service Unavailable" : "Internal Server Error";
    char head[256];
    size_t bl = body ? strlen(body) : 0;
    int hl = snprintf(head, sizeof head,
                      "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
                      code, reason, bl);
    const char *parts[2] = {head, body ? body : ""};
    size_t lens[2] = {(size_t)hl, bl};
    for (int i = 0; i < 2; i++) {
        size_t off = 0;
        while (off < lens[i]) {
            ssize_t w = send(fd, parts[i] + off, lens[i] - off, MSG_NOSIGNAL);
            if (w <= 0) return;
            off += (size_t)w;
        }
    }
}

static void api_reply_error(int fd, int code, const char *what, const char *detail) {
    api_buf_t b = {0};
    api_puts(&b, "{\"error\":\"");
    api_puts(&b, what);
    if (detail) {
        api_puts(&b, ": ");
        for (const char *p = detail; *p && b.n < 400; p++) {           // detail is the library's text: escape it
            char c = *p;
            if (c == '"' || c == '\\') { char e[3] = {'\\', c, 0}; api_puts(&b, e); }
            else if ((unsigned char)c >= 0x20) api_put(&b, &c, 1);
        }
    }
    api_puts(&b, "\"}");
    api_reply(fd, code, b.oom ? "{\"error\":\"out of memory\"}" : b.s);
    free(b.s);
}

static int api_topic_index(const char *t) {
    for (int i = 0; i < api_topics_n; i++) if (strcmp(api_topics[i], t) == 0) return i;
    return -1;
}

static int api_cmp(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

static void api_handle(int fd, const char *method, const char *path, const char *body, size_t blen) {
    if (strcmp(path, "/health") == 0 && strcmp(method, "GET") == 0) {
        char *st = api_b->connection_status ? api_b->connection_status() : NULL;
        int known = st && api_topic_ok(st, strlen(st));                // a plain word, safe to echo
        api_buf_t b = {0};
        api_puts(&b, "{\"nodeHealth\":\"Ready\",\"connectionStatus\":\"");
        api_puts(&b, known ? st : "Unknown");
        api_puts(&b, "\"}");
        free(st);
        api_reply(fd, b.oom ? 500 : 200, b.oom ? "{}" : b.s);
        free(b.s);
        return;
    }
    if (strcmp(path, "/messaging/v1/subscriptions") == 0) {
        if (strcmp(method, "GET") == 0) {
            pthread_mutex_lock(&api_mu);
            char *sorted[API_MAX_TOPICS];
            int n = api_topics_n;
            memcpy(sorted, api_topics, sizeof(char *) * (size_t)n);
            qsort(sorted, (size_t)n, sizeof(char *), api_cmp);
            api_buf_t b = {0};
            api_puts(&b, "[");
            for (int i = 0; i < n; i++) { api_puts(&b, i ? ",\"" : "\""); api_puts(&b, sorted[i]); api_puts(&b, "\""); }
            api_puts(&b, "]");
            pthread_mutex_unlock(&api_mu);
            api_reply(fd, b.oom ? 500 : 200, b.oom ? "[]" : b.s);
            free(b.s);
            return;
        }
        int sub = strcmp(method, "POST") == 0, unsub = strcmp(method, "DELETE") == 0;
        if (!sub && !unsub) { api_reply_error(fd, 405, "method not allowed", NULL); return; }
        char *topics[16];
        int n = api_parse_topics(body, blen, topics, 16);
        if (n < 0) { api_reply_error(fd, 400, "expected a JSON array of content topics", NULL); return; }
        int failed = 0;
        for (int i = 0; i < n; i++) {
            char *err = NULL;
            if (!failed) {
                int rc = sub ? api_b->subscribe(topics[i], &err) : api_b->unsubscribe(topics[i], &err);
                if (rc != 0) {
                    api_reply_error(fd, 500, sub ? "Subscribe failed" : "Unsubscribe failed", err);
                    failed = 1;
                } else {
                    pthread_mutex_lock(&api_mu);
                    int at = api_topic_index(topics[i]);
                    if (sub && at < 0 && api_topics_n < API_MAX_TOPICS) { api_topics[api_topics_n++] = topics[i]; topics[i] = NULL; }
                    if (unsub && at >= 0) { free(api_topics[at]); api_topics[at] = api_topics[--api_topics_n]; }
                    pthread_mutex_unlock(&api_mu);
                }
            }
            free(err);
            free(topics[i]);
        }
        if (!failed) api_reply(fd, 200, "");
        return;
    }
    if (strcmp(path, "/messaging/v1/messages") == 0) {
        if (strcmp(method, "POST") != 0) { api_reply_error(fd, 405, "method not allowed", NULL); return; }
        const char *p = api_ws(body, body + blen);
        if (p >= body + blen || *p != '{' || memchr(body, '\0', blen)) { api_reply_error(fd, 400, "expected a JSON object", NULL); return; }
        char *json = strndup(body, blen), *rid = NULL, *err = NULL;
        int rc = json ? api_b->send(json, &rid, &err) : -1;
        free(json);
        if (rc != 0 || !rid) {
            api_reply_error(fd, 500, "Send failed", err);
        } else {
            // the library may hand the id back quoted
            char *id = rid;
            size_t l = strlen(id);
            if (l >= 2 && id[0] == '"' && id[l - 1] == '"') { id[l - 1] = '\0'; id++; }
            if (!api_id_ok(id)) {
                api_reply_error(fd, 500, "Send failed", "unexpected request id");
            } else {
                char out[200];
                snprintf(out, sizeof out, "{\"requestId\":\"%s\"}", id);
                api_reply(fd, 200, out);
            }
        }
        free(rid);
        free(err);
        return;
    }
    if (strcmp(path, "/messaging/v1/events/received") == 0 && strcmp(method, "GET") == 0) {
        pthread_mutex_lock(&api_mu);
        api_buf_t b = {0};
        api_puts(&b, "[");
        for (int i = 0; i < api_received_n; i++) { if (i) api_puts(&b, ","); api_puts(&b, api_received[i]); }
        api_puts(&b, "]");
        if (!b.oom) {                                                  // evict after poll
            for (int i = 0; i < api_received_n; i++) free(api_received[i]);
            api_received_n = 0;
            api_received_bytes = 0;
        }
        pthread_mutex_unlock(&api_mu);
        api_reply(fd, b.oom ? 500 : 200, b.oom ? "[]" : b.s);
        free(b.s);
        return;
    }
    const char *pre = "/messaging/v1/events/send/";
    if (strncmp(path, pre, strlen(pre)) == 0 && strcmp(method, "GET") == 0) {
        const char *id = path + strlen(pre);
        if (!api_id_ok(id)) { api_reply_error(fd, 400, "Invalid requestId", NULL); return; }
        char *events = NULL;
        pthread_mutex_lock(&api_mu);
        for (int i = 0; i < api_sends_n; i++) {
            if (strcmp(api_sends[i].id, id) == 0) {
                events = api_sends[i].events;                          // evict after poll
                api_sends[i] = api_sends[--api_sends_n];
                break;
            }
        }
        pthread_mutex_unlock(&api_mu);
        if (!events) { api_reply_error(fd, 404, "No send events for requestId", NULL); return; }
        api_buf_t b = {0};
        api_puts(&b, "{\"requestId\":\"");
        api_puts(&b, id);
        api_puts(&b, "\",\"events\":[");
        api_puts(&b, events);
        api_puts(&b, "]}");
        free(events);
        api_reply(fd, b.oom ? 500 : 200, b.oom ? "{}" : b.s);
        free(b.s);
        return;
    }
    api_reply_error(fd, 404, "not found", NULL);
}

static size_t api_content_length(const char *head) {
    // header names are case-insensitive
    for (const char *p = head; (p = strchr(p, '\n')) != NULL; p++) {
        if (strncasecmp(p + 1, "content-length:", 15) == 0) return (size_t)strtoul(p + 16, NULL, 10);
    }
    return 0;
}

static void *api_connection(void *arg) {
    int fd = (int)(intptr_t)arg;
    struct timeval tv = {API_IO_TIMEOUT_S, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    char *buf = malloc(API_MAX_HEADER + 1);
    char *body = NULL;
    size_t n = 0;
    char *end = NULL;
    if (!buf) goto done;
    while (n < API_MAX_HEADER) {
        ssize_t r = recv(fd, buf + n, API_MAX_HEADER - n, 0);
        if (r <= 0) goto done;
        n += (size_t)r;
        buf[n] = '\0';
        if ((end = strstr(buf, "\r\n\r\n")) != NULL) break;
    }
    if (!end) { api_reply_error(fd, 413, "headers too large", NULL); goto done; }
    *end = '\0';
    char method[8] = {0}, path[512] = {0};
    if (sscanf(buf, "%7s %511s HTTP/1.", method, path) != 2) { api_reply_error(fd, 400, "bad request", NULL); goto done; }
    size_t clen = api_content_length(buf);
    if (clen > API_MAX_BODY) { api_reply_error(fd, 413, "body too large", NULL); goto done; }
    body = malloc(clen + 1);
    if (!body) goto done;
    size_t have = n - (size_t)(end + 4 - buf);
    if (have > clen) have = clen;
    memcpy(body, end + 4, have);
    while (have < clen) {
        ssize_t r = recv(fd, body + have, clen - have, 0);
        if (r <= 0) goto done;
        have += (size_t)r;
    }
    body[clen] = '\0';
    api_handle(fd, method, path, body, clen);
done:
    free(buf);
    free(body);
    close(fd);
    pthread_mutex_lock(&api_mu);
    api_open_connections--;
    pthread_mutex_unlock(&api_mu);
    return NULL;
}

static void *api_accept_loop(void *arg) {
    (void)arg;
    for (;;) {
        int fd = accept(api_fd, NULL, NULL);
        if (fd < 0) {
            if (errno == EINTR || errno == ECONNABORTED) continue;
            api_logf("api socket: accept failed: %s", strerror(errno));
            usleep(100000);
            continue;
        }
        pthread_mutex_lock(&api_mu);
        int busy = api_open_connections >= API_MAX_CONNECTIONS;
        if (!busy) api_open_connections++;
        pthread_mutex_unlock(&api_mu);
        if (busy) { api_reply_error(fd, 503, "busy", NULL); close(fd); continue; }
        pthread_t t;
        pthread_attr_t at;
        pthread_attr_init(&at);
        pthread_attr_setdetachstate(&at, PTHREAD_CREATE_DETACHED);
        if (pthread_create(&t, &at, api_connection, (void *)(intptr_t)fd) != 0) {
            close(fd);
            pthread_mutex_lock(&api_mu);
            api_open_connections--;
            pthread_mutex_unlock(&api_mu);
        }
        pthread_attr_destroy(&at);
    }
    return NULL;
}

// With the api socket, the library's own network APIs must be off: the runner refuses a config that could
// turn any of them on, whatever wrote it. The library reads a key case-insensitively, by its option name
// ("rest-admin") or its field name ("restAdmin"), with JSON escapes decoded, and takes 1, "true", "yes" or
// "on" as true (logos-delivery 57e04dc conf_from_json.nim, cli_args.nim; nim-confutils parseCmdArg(bool)).
// So every object key is normalised (lowercase, '-' and '_' dropped), a key with a backslash escape is
// refused outright, and for the keys below anything other than false or null is refused.
// Returns the first such key (normalised), or NULL.
static const char *api_config_opens(const char *config) {
    static const char *keys[] = {"rest", "restadmin", "metricsserver", "websocketsupport", "websocketsecuresupport", NULL};
    const char *p = config, *end = config + strlen(config);
    static char found[64];
    while (p < end) {
        // JSON has no '/' outside strings, but the library's parser takes // and /* */ comments, and a quote
        // inside a comment would put this scanner out of step: refuse any (review E2)
        if (*p == '/') return "a comment";
        if (*p != '"') { p++; continue; }
        const char *s = ++p;                                   // a string token: skip it whole
        int escaped = 0;
        while (p < end && *p != '"') {
            if (*p == '\\') { escaped = 1; p += (p + 1 < end) ? 2 : 1; } else p++;
        }
        if (p >= end) return "unterminated string";
        const char *e = p++;
        const char *q = api_ws(p, end);
        if (q >= end || *q != ':') continue;                   // not a key
        if (escaped) return "a key with an escape";
        char norm[64];
        size_t n = 0;
        for (const char *c = s; c < e && n + 1 < sizeof norm; c++) {
            if (*c == '-' || *c == '_') continue;
            norm[n++] = (char)((*c >= 'A' && *c <= 'Z') ? *c - 'A' + 'a' : *c);
        }
        norm[n] = '\0';
        for (const char **k = keys; *k; k++) {
            if (strcmp(norm, *k) != 0) continue;
            const char *v = api_ws(q + 1, end);
            size_t left = (size_t)(end - v);
            const char *after = NULL;
            if (left >= 5 && memcmp(v, "false", 5) == 0) after = v + 5;
            else if (left >= 4 && memcmp(v, "null", 4) == 0) after = v + 4;
            after = after ? api_ws(after, end) : NULL;
            if (!after || (after < end && *after != ',' && *after != '}')) {
                snprintf(found, sizeof found, "%s", *k);
                return found;
            }
        }
    }
    return NULL;
}

// The library also reads every option it isn't given on the command line from the environment, as
// <PROGRAM>_<OPTION> (nim-confutils load(), envVarsPrefix = the program's name, e.g. LIBWAKURUNNER_REST_ADMIN).
// With the api socket the runner removes every such variable for the network APIs before it creates the node,
// whatever its prefix, so only the config decides, and the config check above covers that (review E4).
// Returns how many were removed.
static int api_clear_env(void) {
    extern char **environ;
    static const char *suffixes[] = {"_REST", "_REST_ADMIN", "_METRICS_SERVER", "_WEBSOCKET_SUPPORT",
                                     "_WEBSOCKET_SECURE_SUPPORT", NULL};
    int removed = 0;
    for (int again = 1; again;) {
        again = 0;
        for (char **e = environ; e && *e; e++) {
            const char *eq = strchr(*e, '=');
            if (!eq) continue;
            size_t n = (size_t)(eq - *e);
            for (const char **s = suffixes; *s; s++) {
                size_t sl = strlen(*s);
                if (n < sl) continue;                          // a name that is exactly the suffix counts too
                const char *tail = *e + n - sl;                // compared in place, case-insensitively: any length
                size_t i = 0;
                while (i < sl && (char)((tail[i] >= 'a' && tail[i] <= 'z') ? tail[i] - 'a' + 'A' : tail[i]) == (*s)[i]) i++;
                if (i != sl) continue;
                char *name = strndup(*e, n);                   // the variable's own spelling
                if (!name) return removed;
                unsetenv(name);
                free(name);
                removed++;
                again = 1;                                     // environ changed: start over
                break;
            }
            if (again) break;
        }
    }
    return removed;
}

// Opens the socket at `path` and serves it on a thread of its own. The path's directory must be a
// real directory owned by this user with no group or other access; a socket left there by an earlier
// run is removed only if nothing answers on it. Returns 0, or -1 (and logs why): then the runner must
// not run without it, since there is no other way in.
static int api_start(const char *path, const api_backend_t *backend) {
    api_b = backend;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    if (!path || path[0] != '/' || strlen(path) >= sizeof addr.sun_path) {
        api_logf("api socket: the path must be absolute and shorter than %zu bytes", sizeof addr.sun_path);
        return -1;
    }
    strcpy(addr.sun_path, path);
    char dir[sizeof addr.sun_path];
    strcpy(dir, path);
    char *slash = strrchr(dir, '/');
    if (slash == dir) slash[1] = '\0'; else *slash = '\0';
    struct stat ds;
    if (lstat(dir, &ds) != 0 || !S_ISDIR(ds.st_mode) || ds.st_uid != geteuid() || (ds.st_mode & 077) != 0) {
        api_logf("api socket: %s must be a directory owned by this user with no group or other access", dir);
        return -1;
    }
    struct stat ss;
    if (lstat(path, &ss) == 0) {
        if (!S_ISSOCK(ss.st_mode)) { api_logf("api socket: %s exists and is not a socket", path); return -1; }
        int probe = socket(AF_UNIX, SOCK_STREAM, 0);
        int live = probe >= 0 && connect(probe, (struct sockaddr *)&addr, sizeof addr) == 0;
        int refused = !live && errno == ECONNREFUSED;
        if (probe >= 0) close(probe);
        if (live) { api_logf("api socket: another process already serves %s", path); return -1; }
        if (!refused || unlink(path) != 0) { api_logf("api socket: can't replace %s: %s", path, strerror(errno)); return -1; }
    }
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) { api_logf("api socket: socket: %s", strerror(errno)); return -1; }
    mode_t old = umask(077);
    int rc = bind(fd, (struct sockaddr *)&addr, sizeof addr);
    umask(old);
    if (rc != 0 || chmod(path, 0600) != 0 || listen(fd, 16) != 0) {
        api_logf("api socket: can't listen on %s: %s", path, strerror(errno));
        close(fd);
        return -1;
    }
    api_fd = fd;
    pthread_t t;
    if (pthread_create(&t, NULL, api_accept_loop, NULL) != 0) {
        api_logf("api socket: no thread");
        close(fd);
        api_fd = -1;
        return -1;
    }
    pthread_detach(t);
    api_logf("api socket %s (owner only); the library's REST API is not used", path);
    return 0;
}

#endif
