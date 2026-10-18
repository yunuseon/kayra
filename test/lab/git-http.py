"""git's smart HTTP for the upgrade lab: `git http-backend` behind Python's
own WSGI server, so the VM can clone the fixture app shallowly (kayra clones
with --depth 1, which a static file server cannot answer).

    python3 git-http.py <address> <port> <directory of bare repositories>
"""
import subprocess
import sys
from wsgiref.simple_server import WSGIRequestHandler, make_server

address, port, root = sys.argv[1], int(sys.argv[2]), sys.argv[3]


def app(environ, start_response):
    length = int(environ.get("CONTENT_LENGTH") or 0)
    body = environ["wsgi.input"].read(length) if length else b""
    env = {
        "GIT_PROJECT_ROOT": root,
        "GIT_HTTP_EXPORT_ALL": "1",
        "PATH_INFO": environ.get("PATH_INFO", ""),
        "QUERY_STRING": environ.get("QUERY_STRING", ""),
        "REQUEST_METHOD": environ["REQUEST_METHOD"],
        "CONTENT_TYPE": environ.get("CONTENT_TYPE", ""),
        "CONTENT_LENGTH": str(length),
        "GIT_PROTOCOL": environ.get("HTTP_GIT_PROTOCOL", ""),
        "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    }
    out = subprocess.run(["git", "http-backend"], input=body, env=env, capture_output=True).stdout
    head, _, payload = out.partition(b"\r\n\r\n")
    status, headers = "200 OK", []
    for line in head.decode().split("\r\n"):
        name, _, value = line.partition(": ")
        if name.lower() == "status":
            status = value
        elif name:
            headers.append((name, value))
    start_response(status, headers)
    return [payload]


class Quiet(WSGIRequestHandler):
    def log_message(self, *args):
        pass


make_server(address, port, app, handler_class=Quiet).serve_forever()
