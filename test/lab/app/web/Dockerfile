FROM busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
COPY index.html /www/index.html
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
