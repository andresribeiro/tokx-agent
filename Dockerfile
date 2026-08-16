FROM denoland/deno:distroless-2.9.5

WORKDIR /app
COPY deno.json main.ts ./
COPY src ./src

ENV HOME=/home/deno \
    STATE_DIR=/state

ENTRYPOINT ["deno", "run", "--allow-env", "--allow-read", "--allow-write", "--allow-net", "--allow-sys", "--no-prompt", "main.ts"]
