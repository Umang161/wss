#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE_NAME="${IMAGE_NAME:-wss}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
FULL_IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"

# Default: build for current machine (native). Works on Mac (arm64/amd64) and Linux.
# For EC2 (x86_64): PLATFORM=linux/amd64 ./scripts/build-docker.sh
PLATFORM="${PLATFORM:-}"

cd "$ROOT_DIR"
if [[ -n "$PLATFORM" ]]; then
  echo "Building Docker image: $FULL_IMAGE (platform: $PLATFORM)"
  docker build --platform "$PLATFORM" -t "$FULL_IMAGE" .
else
  echo "Building Docker image: $FULL_IMAGE (native)"
  docker build -t "$FULL_IMAGE" .
fi
echo "Done. Run with: docker run -p 8080:8080 --env-file .env $FULL_IMAGE"
