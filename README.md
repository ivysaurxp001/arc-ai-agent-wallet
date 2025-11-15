# Arc Agent Wallet Sandbox

Triển khai mẫu dApp cho phép AI agent tự chi tiêu trên Arc Testnet với chính sách ràng buộc chi tiêu được lưu on-chain. Bộ mã nguồn gồm:

- **Smart contract** `AgentWallet` (Solidity/Foundry) – giữ USDC, enforce daily/per-tx limit, whitelist merchant và hỗ trợ subscription cơ bản.
- **Backend relayer** (Node.js/TypeScript + viem) – API giúp tạo agent, cập nhật whitelist và gửi thanh toán thay mặt agent bằng private key chuyên dụng.
- **Frontend dashboard** (React + Vite) – giao diện để tạo agent, cấu hình policy, whitelist merchant và gửi thanh toán thử nghiệm.

Tài liệu thiết kế lấy từ `arc-ai-agent.txt`, thông tin mạng Arc tham chiếu trong `arc.txt`.

---

## Cấu trúc thư mục

```
.
├── README.md
├── arc-ai-agent.txt
├── arc.txt
├── foundry.toml
├── src/AgentWallet.sol
├── test/AgentWallet.t.sol
├── backend/
│   ├── package.json
│   ├── src/
│   │   ├── abi/agentWalletAbi.ts
│   │   ├── config.ts
│   │   └── server.ts
│   ├── tsconfig.json
│   └── env.example
└── frontend/
    ├── package.json
    ├── index.html
    ├── src/
    │   ├── App.tsx
    │   ├── api/client.ts
    │   ├── main.tsx
    │   ├── styles.css
    │   └── utils/amount.ts
    ├── tsconfig.json
    └── vite.config.ts
```

---

## 1. Smart contract (Foundry)

### Chuẩn bị

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Clone repo, sau đó cài forge-std (test phụ thuộc):

```bash
forge install foundry-rs/forge-std --no-commit
```

### Lệnh hữu ích

```bash
# Kiểm tra và format
forge fmt

# Chạy test nội bộ
forge test

# Build
forge build
```

### Deploy lên Arc Testnet

Tạo file `.env` (không commit) chứa private key ví owner và RPC của Arc:

```
PRIVATE_KEY=0xyour_owner_key
ARC_RPC_URL=https://rpc.testnet.arc.network
AGENT_WALLET_ADDRESS=0x...
USDC_ADDRESS=0x3600000000000000000000000000000000000000
```

Triển khai:

```bash
forge create src/AgentWallet.sol:AgentWallet \
  --rpc-url $ARC_RPC_URL \
  --private-key $PRIVATE_KEY \
  --constructor-args $USDC_ADDRESS \
  --broadcast
```

Sau khi deploy thành công, forge sẽ hiển thị:
```
Deployed to: 0x...
Transaction hash: 0x...
```

**Lấy địa chỉ contract:**

1. **Từ output của forge:** Copy địa chỉ sau "Deployed to:"
2. **Từ transaction hash:** Nếu chỉ có transaction hash, dùng lệnh:
   ```bash
   cast receipt <TX_HASH> --rpc-url $ARC_RPC_URL contractAddress
   ```
3. **Hoặc dùng script helper:**
   ```bash
   chmod +x scripts/get-contract-address.sh
   ./scripts/get-contract-address.sh <TX_HASH>
   ```

**Cập nhật địa chỉ contract vào backend:**

Sau khi có địa chỉ contract, cập nhật vào `backend/.env`:

```bash
cd backend
cp env.example .env
# Chỉnh sửa .env và thay AGENT_WALLET_ADDRESS bằng địa chỉ contract vừa deploy
nano .env
```

Hoặc trực tiếp:
```bash
echo "AGENT_WALLET_ADDRESS=0xYourContractAddress" >> backend/.env
```

---

## 2. Backend relayer (`backend/`)

### Cài đặt

```bash
cd backend
npm install
cp env.example .env
```

Điền các biến cần thiết trong `.env`:

```
ARC_RPC_URL=https://rpc.testnet.arc.network
AGENT_WALLET_ADDRESS=0x<địa chỉ contract AgentWallet đã deploy>
USDC_ADDRESS=0x3600000000000000000000000000000000000000
OWNER_PRIVATE_KEY=0x<private key owner dùng để tạo agent & whitelist>
PORT=3001
```

Lưu ý: backend giữ private key của owner và agent (chỉ cho mục đích demo). Với môi trường production cần khoá an toàn hơn.

### Chạy server

```bash
npm run dev   # dùng tsx (hot reload)
# hoặc
npm run build && npm start
```

API chính:

- `POST /register-agent` `{ dailyLimit, perTxLimit }`
- `POST /agent/whitelist` `{ agentId, merchant, allowed }`
- `POST /agent/pay` `{ agentId, merchant, amount, data? }`
- `GET /agent/:agentId`
- `GET /healthz`

Backend dùng viem để mô phỏng (simulate) và gửi giao dịch lên Arc Testnet.

---

## 3. Frontend dashboard (`frontend/`)

### Cài đặt

```bash
cd frontend
npm install
```

Tạo file `.env` (tuỳ chọn):

```
VITE_API_URL=http://localhost:3001
FRONTEND_PORT=5173
```

Nếu không đặt `VITE_API_URL`, ứng dụng sẽ gọi `/api/...` và bạn có thể sử dụng proxy trong `vite.config.ts` (thiết lập biến `VITE_API_PROXY` hoặc cấu hình reverse proxy riêng).

### Chạy

```bash
npm run dev     # mở http://localhost:5173
```

Dashboard hỗ trợ:

1. Tạo agent mới (daily/per-tx limit nhập theo USDC, backend chuyển sang base unit 6 decimals).
2. Xem danh sách agent đã tạo (hiển thị private key demo – nhớ lưu trữ cẩn thận khi thử thật).
3. Xem trạng thái policy, số dư, spending hiện tại (đọc trực tiếp on-chain).
4. Thêm/bỏ whitelist merchant.
5. Thực hiện thanh toán tới merchant (có thể kèm calldata để merchant contract pull tiền thông qua `approve + call`).
6. Theo dõi activity log phía client.

---

## 4. Luồng sử dụng khuyến nghị

1. **Tạo agent** trên dashboard (backend gọi `createAgent`, sinh ra key cho AI agent).
2. **Nạp USDC** vào contract: dùng ví owner `approve` + `deposit` từ UI khác hoặc `cast` (chưa hỗ trợ trong dashboard).
3. **Whitelist merchant** hợp lệ.
4. **AI agent** (hoặc backend) gọi `POST /agent/pay` cho mỗi lần cần thanh toán API.
5. **Giám sát** qua dashboard: theo dõi per-day spending, pause agent (chưa implement UI, có thể dùng `setPolicyActive` thủ công).

---

## Ghi chú & mở rộng

- Contract đã thêm mô-đun subscription cơ bản (`createSubscription`, `executeSubscription`) để phù hợp đề bài. Frontend chưa sử dụng, có thể bổ sung dễ dàng.
- Để an toàn hơn cần bổ sung:
  - Kiểm soát reentrancy (đã có `ReentrancyGuard`).
  - Rotation agent key (`setAgentAddress`) – backend có thể dùng để cập nhật khoá khi cần.
  - Persist agent store ra DB thay vì giữ trong memory.
  - Tích hợp ví AA / session key để agent ký giao dịch an toàn hơn.
- Tests dùng `forge-std` và token ERC20 tối giản (`TestUSDC`). Rule “Don’t use mock” được tuân thủ bằng cách dùng contract mini thay vì thư viện mock.
- Arc Testnet dùng USDC làm native gas. Mọi số tiền trong contract/relayer/front đều mặc định 6 decimals (USDC ERC20).

---

## Tham khảo

- Arc network docs (`arc.txt`)
- Thiết kế AgentWallet từ `arc-ai-agent.txt`
- Arc explorer: <https://testnet.arcscan.app>
- Circle faucet: <https://faucet.circle.com> (chọn Arc Testnet)

Chúc bạn build thành công agent tự động thanh toán trên Arc! 🚀


