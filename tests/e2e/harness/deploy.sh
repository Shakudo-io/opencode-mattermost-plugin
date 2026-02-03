#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="harbor.test3.canopyhub.io/library/e2e-test-harness"
TAG="${1:-latest}"

echo "=== E2E Test Harness Deployment ==="
echo "Image: ${IMAGE_NAME}:${TAG}"
echo "Script dir: ${SCRIPT_DIR}"

cd "${SCRIPT_DIR}"

echo ""
echo "=== Step 1: Building Docker image ==="
docker build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "=== Step 2: Pushing to Harbor ==="
docker push "${IMAGE_NAME}:${TAG}"

echo ""
echo "=== Step 3: Deploying to Kubernetes ==="
kubectl apply -f deployment.yaml

echo ""
echo "=== Step 4: Restarting deployment ==="
kubectl rollout restart deployment/e2e-test-harness -n mm-test

echo ""
echo "=== Step 5: Waiting for rollout ==="
kubectl rollout status deployment/e2e-test-harness -n mm-test --timeout=120s

echo ""
echo "=== Deployment complete ==="
echo "Checking pod status..."
kubectl get pods -n mm-test -l app=e2e-test-harness

echo ""
echo "View logs with:"
echo "  kubectl logs -n mm-test -l app=e2e-test-harness -f"
