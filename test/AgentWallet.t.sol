// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AgentWallet.sol";

contract TestUSDC is IERC20 {
    string public constant name = "Test USDC";
    string public constant symbol = "tUSDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 currentAllowance = _allowances[from][msg.sender];
        require(currentAllowance >= amount, "allowance");
        _allowances[from][msg.sender] = currentAllowance - amount;
        _transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        _allowances[msg.sender][spender] = amount;
        return true;
    }

    function allowance(address owner, address spender) external view override returns (uint256) {
        return _allowances[owner][spender];
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _balances[account];
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(_balances[from] >= amount, "balance");
        _balances[from] -= amount;
        _balances[to] += amount;
    }
}

contract PullMerchant {
    IERC20 public immutable token;
    uint256 public totalReceived;
    uint256 public lastInvoiceId;

    constructor(IERC20 token_) {
        token = token_;
    }

    function charge(uint256 amount, uint256 invoiceId) external {
        lastInvoiceId = invoiceId;
        totalReceived += amount;
        bool success = token.transferFrom(msg.sender, address(this), amount);
        require(success, "charge: transfer failed");
    }
}

contract AgentWalletTest is Test {
    TestUSDC internal usdc;
    AgentWallet internal wallet;
    PullMerchant internal pullMerchant;

    address internal agentOwner = address(0xA11CE);
    address internal agentAddress = address(0xA91317);
    address internal merchant;

    function setUp() public {
        usdc = new TestUSDC();
        wallet = new AgentWallet(IERC20(address(usdc)));
        pullMerchant = new PullMerchant(IERC20(address(usdc)));
        merchant = address(pullMerchant);
    }

    function testCreateAgentInitialisesPolicy() public {
        vm.prank(agentOwner);
        uint256 agentId = wallet.createAgent(agentAddress, 1_000_000, 250_000);

        AgentWallet.AgentConfig memory config = wallet.agent(agentId);
        assertEq(config.owner, agentOwner, "owner mismatch");
        assertEq(config.agent, agentAddress, "agent mismatch");
        assertTrue(config.policy.active, "policy inactive");
        assertEq(config.policy.dailyLimit, 1_000_000, "daily limit mismatch");
        assertEq(config.policy.perTxLimit, 250_000, "per tx limit mismatch");
    }

    function testDepositAndPayDirectTransfer() public {
        uint256 agentId = _createAgentWithBalance(1_000_000);

        vm.prank(agentOwner);
        wallet.setMerchantWhitelist(agentId, merchant, true);

        vm.prank(agentAddress);
        wallet.pay(agentId, merchant, 200_000, "");

        assertEq(usdc.balanceOf(merchant), 200_000, "merchant balance");
        assertEq(wallet.balanceOf(agentId), 800_000, "wallet balance");
        assertEq(wallet.spentToday(agentId), 200_000, "spent today");
    }

    function testPayWithCalldataExecutesMerchantCall() public {
        uint256 agentId = _createAgentWithBalance(500_000);
        vm.prank(agentOwner);
        wallet.setMerchantWhitelist(agentId, merchant, true);

        vm.prank(agentAddress);
        wallet.pay(agentId, merchant, 100_000, abi.encodeWithSignature("charge(uint256,uint256)", 100_000, 123));

        assertEq(usdc.balanceOf(merchant), 100_000, "merchant pull balance");
        assertEq(pullMerchant.totalReceived(), 100_000, "total received");
        assertEq(pullMerchant.lastInvoiceId(), 123, "invoice id mismatch");
    }

    function testDailyLimitResetsAfterOneDay() public {
        uint256 agentId = _createAgentWithBalance(2_000_000);
        vm.prank(agentOwner);
        wallet.setMerchantWhitelist(agentId, merchant, true);

        vm.prank(agentAddress);
        wallet.pay(agentId, merchant, 900_000, "");

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(agentAddress);
        wallet.pay(agentId, merchant, 800_000, "");

        assertEq(wallet.spentToday(agentId), 800_000, "new day spend");
    }

    function testEmergencyWithdrawTransfersFullBalance() public {
        uint256 agentId = _createAgentWithBalance(750_000);
        vm.prank(agentOwner);
        wallet.emergencyWithdraw(agentId);

        assertEq(wallet.balanceOf(agentId), 0, "wallet balance not zero");
        assertEq(usdc.balanceOf(agentOwner), 750_000, "owner balance mismatch");
    }

    function _createAgentWithBalance(uint256 amount) internal returns (uint256 agentId) {
        vm.prank(agentOwner);
        agentId = wallet.createAgent(agentAddress, 1_000_000_000, 500_000_000);

        usdc.mint(agentOwner, amount);
        vm.startPrank(agentOwner);
        usdc.approve(address(wallet), amount);
        wallet.deposit(agentId, amount);
        vm.stopPrank();
    }
}


