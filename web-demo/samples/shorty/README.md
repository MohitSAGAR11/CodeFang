# shorty

A tiny in-memory URL shortener.

```console
$ go run .
$ curl -XPOST localhost:8080/shorten -d '{"url":"https://example.com"}'
{"code":"k3J9aQ","short":"http://localhost:8080/k3J9aQ"}
$ curl -i localhost:8080/k3J9aQ
HTTP/1.1 302 Found
Location: https://example.com
```

Links live in memory and vanish on restart.
