# Local CI runner for justybase-vscode.
#
# Matches the GitHub Actions Node version (24) and provides the Linux system
# libraries required by Jest, native npm modules, and the VS Code Extension
# Host under Xvfb. Database engines and publishing tools belong to later
# stages and are intentionally not installed here.
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    ELECTRON_DISABLE_SANDBOX=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        jq \
        rsync \
        unzip \
        zip \
        xz-utils \
        build-essential \
        python3 \
        pkg-config \
        xvfb \
        xauth \
        dbus \
        dbus-x11 \
        fonts-liberation \
        fonts-noto-color-emoji \
        libasound2 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libegl1 \
        libexpat1 \
        libgbm1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libsecret-1-0 \
        libvulkan1 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        libxshmfence1 \
        libxss1 \
        libxtst6 \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /work /ci-state /out /home/node/.cache /home/node/.vscode-test \
    && chown -R node:node /work /ci-state /out /home/node/.cache /home/node/.vscode-test

USER node

# /src is a read-only bind mount of the host checkout. The orchestrator copies
# it into the disposable /work volume before running any stage.
WORKDIR /src

CMD ["node", "--version"]
