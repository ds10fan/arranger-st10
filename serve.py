#!/usr/bin/env python3
"""Serve arranger-st10.html over HTTPS with a self-signed certificate.

Usage:
    python3 serve.py [port]        # default port 9988

On first run cert.pem / key.pem are generated (requires openssl) with SANs for
localhost and this machine's IP addresses. Delete them to regenerate, or replace
them with your own certificate. The browser warns about the self-signed cert;
accept it once.
"""
import http.server
import os
import socket
import ssl
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CERT = os.path.join(HERE, "cert.pem")
KEY = os.path.join(HERE, "key.pem")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9988


def local_ips():
    ips = {"127.0.0.1"}
    try:
        out = subprocess.run(["hostname", "-I"], capture_output=True, text=True).stdout
        ips.update(out.split())
    except OSError:
        pass
    return sorted(ip for ip in ips if ":" not in ip)


def ensure_cert():
    if os.path.exists(CERT) and os.path.exists(KEY):
        return
    host = socket.gethostname()
    san = ",".join(["DNS:localhost", f"DNS:{host}"] + [f"IP:{ip}" for ip in local_ips()])
    print(f"Generating self-signed certificate ({san})")
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", KEY, "-out", CERT,
            "-days", "825", "-nodes",
            "-subj", "/CN=arranger-st10",
            "-addext", f"subjectAltName={san}",
        ],
        check=True,
    )


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    def send_head(self):
        # only the single shipping file is served
        if self.path.split("?")[0] not in ("/", "/index.html", "/arranger-st10.html"):
            self.send_error(404)
            return None
        self.path = "/arranger-st10.html"
        return super().send_head()

    def guess_type(self, path):
        # the page has no <meta charset>; without this browsers fall back to a legacy encoding
        return "text/html; charset=utf-8"

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    ensure_cert()
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=CERT, keyfile=KEY)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f"Serving arranger-st10.html on https://localhost:{PORT}/")
    for ip in local_ips():
        print(f"  https://{ip}:{PORT}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
