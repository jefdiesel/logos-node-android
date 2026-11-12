/*
 * A stand-in for libpcsclite, linked statically into the Android build of the `names` command.
 *
 * The LEZ wallet that `names` is built on can talk to a hardware Keycard over PC/SC (the `pcsc`
 * crate). Android has no PC/SC service and no libpcsclite, and the app never uses a Keycard. Every
 * function here answers SCARD_E_NO_SERVICE ("the smart card service is not running"), which the
 * `pcsc` crate turns into an ordinary error. No card code runs; nothing here touches keys.
 *
 * The signatures follow pcsc-sys 1.3.0 for Linux-like targets: LONG and DWORD are C long and
 * unsigned long, SCARDCONTEXT and SCARDHANDLE are LONG.
 */
#include <stddef.h>

typedef long LONG;
typedef unsigned long DWORD;
typedef LONG SCARDCONTEXT;
typedef LONG SCARDHANDLE;

typedef struct {
    DWORD dwProtocol;
    DWORD cbPciLength;
} SCARD_IO_REQUEST;

#define SCARD_E_NO_SERVICE ((LONG)0x8010001D)

const SCARD_IO_REQUEST g_rgSCardT0Pci = {1, sizeof(SCARD_IO_REQUEST)};
const SCARD_IO_REQUEST g_rgSCardT1Pci = {2, sizeof(SCARD_IO_REQUEST)};
const SCARD_IO_REQUEST g_rgSCardRawPci = {4, sizeof(SCARD_IO_REQUEST)};

LONG SCardEstablishContext(DWORD scope, const void *r1, const void *r2, SCARDCONTEXT *ctx) {
    (void)scope; (void)r1; (void)r2;
    if (ctx) *ctx = 0;
    return SCARD_E_NO_SERVICE;
}
LONG SCardReleaseContext(SCARDCONTEXT ctx) { (void)ctx; return SCARD_E_NO_SERVICE; }
LONG SCardIsValidContext(SCARDCONTEXT ctx) { (void)ctx; return SCARD_E_NO_SERVICE; }
LONG SCardCancel(SCARDCONTEXT ctx) { (void)ctx; return SCARD_E_NO_SERVICE; }
LONG SCardConnect(SCARDCONTEXT ctx, const char *reader, DWORD share, DWORD protocols,
                  SCARDHANDLE *card, DWORD *active) {
    (void)ctx; (void)reader; (void)share; (void)protocols; (void)card; (void)active;
    return SCARD_E_NO_SERVICE;
}
LONG SCardReconnect(SCARDHANDLE card, DWORD share, DWORD protocols, DWORD init, DWORD *active) {
    (void)card; (void)share; (void)protocols; (void)init; (void)active;
    return SCARD_E_NO_SERVICE;
}
LONG SCardDisconnect(SCARDHANDLE card, DWORD disposition) {
    (void)card; (void)disposition;
    return SCARD_E_NO_SERVICE;
}
LONG SCardGetStatusChange(SCARDCONTEXT ctx, DWORD timeout, void *states, DWORD count) {
    (void)ctx; (void)timeout; (void)states; (void)count;
    return SCARD_E_NO_SERVICE;
}
LONG SCardListReaders(SCARDCONTEXT ctx, const char *groups, char *readers, DWORD *len) {
    (void)ctx; (void)groups; (void)readers; (void)len;
    return SCARD_E_NO_SERVICE;
}
LONG SCardBeginTransaction(SCARDHANDLE card) { (void)card; return SCARD_E_NO_SERVICE; }
LONG SCardEndTransaction(SCARDHANDLE card, DWORD disposition) {
    (void)card; (void)disposition;
    return SCARD_E_NO_SERVICE;
}
LONG SCardStatus(SCARDHANDLE card, char *names, DWORD *names_len, DWORD *state, DWORD *protocol,
                 unsigned char *atr, DWORD *atr_len) {
    (void)card; (void)names; (void)names_len; (void)state; (void)protocol; (void)atr; (void)atr_len;
    return SCARD_E_NO_SERVICE;
}
LONG SCardGetAttrib(SCARDHANDLE card, DWORD id, unsigned char *attr, DWORD *len) {
    (void)card; (void)id; (void)attr; (void)len;
    return SCARD_E_NO_SERVICE;
}
LONG SCardSetAttrib(SCARDHANDLE card, DWORD id, const unsigned char *attr, DWORD len) {
    (void)card; (void)id; (void)attr; (void)len;
    return SCARD_E_NO_SERVICE;
}
LONG SCardTransmit(SCARDHANDLE card, const SCARD_IO_REQUEST *send_pci, const unsigned char *send,
                   DWORD send_len, SCARD_IO_REQUEST *recv_pci, unsigned char *recv, DWORD *recv_len) {
    (void)card; (void)send_pci; (void)send; (void)send_len; (void)recv_pci; (void)recv; (void)recv_len;
    return SCARD_E_NO_SERVICE;
}
LONG SCardControl(SCARDHANDLE card, DWORD code, const void *send, DWORD send_len, void *recv,
                  DWORD recv_len, DWORD *returned) {
    (void)card; (void)code; (void)send; (void)send_len; (void)recv; (void)recv_len; (void)returned;
    return SCARD_E_NO_SERVICE;
}
