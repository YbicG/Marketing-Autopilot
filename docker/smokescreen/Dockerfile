# Smokescreen egress proxy for the capture Chromium and safe-fetch (plan D8, §3.2).
# Built from source at a pinned commit (tag v0.1.0) so the image never changes under us.
FROM golang:1.25-alpine AS build
ARG SMOKESCREEN_REF=609eb8931420453daf5893509be0b25b21bd9edb
RUN apk add --no-cache git
WORKDIR /src
RUN git init -q . && git remote add origin https://github.com/stripe/smokescreen.git \
  && git fetch -q --depth 1 origin "$SMOKESCREEN_REF" && git checkout -q FETCH_HEAD
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/smokescreen .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates \
  && addgroup -S -g 1001 smokescreen && adduser -S -D -H -u 1001 -G smokescreen smokescreen
COPY --from=build /out/smokescreen /usr/local/bin/smokescreen
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# Tolerate a CRLF checkout on Windows.
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod 0755 /usr/local/bin/entrypoint.sh
USER smokescreen
EXPOSE 4750
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
