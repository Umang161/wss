#!/usr/bin/env bash
set -euo pipefail

# Push to Docker Hub as zofthub/wss
# Builds for linux/amd64 so the image runs natively on typical cloud VMs (e.g. EC2).
# Usage: ./scripts/push-docker.sh [tag]
# Example: ./scripts/push-docker.sh    -> pushes zofthub/wss:latest
#          ./scripts/push-docker.sh v1 -> pushes zofthub/wss:v1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DOCKERHUB_USER="${DOCKERHUB_USER:-zofthub}"
REPO_NAME="${REPO_NAME:-wss}"
IMAGE_TAG="${1:-latest}"
FULL_IMAGE="${DOCKERHUB_USER}/${REPO_NAME}:${IMAGE_TAG}"

cd "$ROOT_DIR"

echo "Building $FULL_IMAGE for linux/amd64 ..."
PLATFORM=linux/amd64 IMAGE_NAME="${DOCKERHUB_USER}/${REPO_NAME}" IMAGE_TAG="$IMAGE_TAG" ./scripts/build-docker.sh

echo "Pushing $FULL_IMAGE to Docker Hub ..."
docker push "$FULL_IMAGE"
echo "Done. Image available at: https://hub.docker.com/r/${DOCKERHUB_USER}/${REPO_NAME}"
