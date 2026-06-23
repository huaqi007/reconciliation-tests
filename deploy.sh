#!/bin/bash
# ============================================================
# SimpleToken 部署脚本 — 用 keystore 方式部署
#
# 用法：
#   # 1. 先导入私钥到 keystore（一次性）
#   cast wallet import deployer --keystore-dir ~/.foundry/keystores
#   # 输入私钥 + 密码
#
#   # 2. 部署
#   ./deploy.sh sepolia    # 部署到 Sepolia 测试网
#   ./deploy.sh mainnet    # 部署到主网
#   ./deploy.sh local      # 部署到本地 anvil
#
#   # 3. 把输出的地址填入 .env 的 CONTRACT_ADDRESS
# ============================================================
set -euo pipefail

NETWORK="${1:-local}"
KEYSTORE_DIR="${KEYSTORE_DIR:-$HOME/.foundry/keystores}"
KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"  # foundry-parctice 根目录

cd "$ROOT_DIR"

case "$NETWORK" in
  local)
    RPC_URL="http://127.0.0.1:8545"
    # 本地 anvil 用第一个默认私钥，不需要 keystore
    PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    echo ">>> 部署到本地 anvil..."
    forge create --rpc-url "$RPC_URL" \
      --private-key "$PRIVATE_KEY" \
      src/SimpleToken.sol:SimpleToken
    ;;

  sepolia)
    RPC_URL="${SEPOLIA_RPC_URL:-https://sepolia.infura.io/v3/YOUR_KEY}"
    if [ -z "$KEYSTORE_PASSWORD" ]; then
      echo "请输入 keystore 密码："
      read -rs KEYSTORE_PASSWORD
    fi
    echo ">>> 部署到 Sepolia 测试网..."
    forge create --rpc-url "$RPC_URL" \
      --keystore "$KEYSTORE_DIR/deployer" \
      --password "$KEYSTORE_PASSWORD" \
      src/SimpleToken.sol:SimpleToken
    ;;

  mainnet)
    RPC_URL="${MAINNET_RPC_URL:-https://mainnet.infura.io/v3/YOUR_KEY}"
    if [ -z "$KEYSTORE_PASSWORD" ]; then
      echo "请输入 keystore 密码："
      read -rs KEYSTORE_PASSWORD
    fi
    echo "⚠️  即将部署到主网！Ctrl+C 取消..."
    sleep 5
    echo ">>> 部署到主网..."
    forge create --rpc-url "$RPC_URL" \
      --keystore "$KEYSTORE_DIR/deployer" \
      --password "$KEYSTORE_PASSWORD" \
      src/SimpleToken.sol:SimpleToken
    ;;

  *)
    echo "用法: $0 {local|sepolia|mainnet}"
    exit 1
    ;;
esac

echo ""
echo "✅ 部署完成。把上面的 'Deployed to:' 地址填入 reconciliation-tests/.env 的 CONTRACT_ADDRESS"
