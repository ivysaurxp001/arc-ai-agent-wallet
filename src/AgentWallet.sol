// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC20 interface required by the AgentWallet contract.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function approve(address spender, uint256 amount) external returns (bool);

    function allowance(address owner, address spender) external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);
}

/// @notice Simplified Ownable implementation used to manage platform-level controls.
abstract contract Ownable {
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address initialOwner) {
        require(initialOwner != address(0), "Ownable: zero address");
        _owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        require(msg.sender == _owner, "Ownable: caller not owner");
        _;
    }

    function owner() public view returns (address) {
        return _owner;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Ownable: zero address");
        address previousOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }
}

/// @notice Gas-efficient reentrancy guard inspired by OpenZeppelin.
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    uint256 private _status;

    constructor() {
        _status = _NOT_ENTERED;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

/// @title AgentWallet
/// @notice Smart-contract enforced spending policies for AI agents on Arc.
contract AgentWallet is Ownable, ReentrancyGuard {
    /// @notice Policy configuration describing how an agent may spend funds.
    struct Policy {
        bool active;
        uint256 dailyLimit;
        uint256 perTxLimit;
        uint256 spentToday;
        uint64 lastReset;
    }

    /// @notice Complete configuration for an individual agent.
    struct AgentConfig {
        address owner;
        address agent;
        Policy policy;
    }

    /// @notice Tracks subscription style authorisations (placeholder for future extensions).
    struct Subscription {
        address merchant;
        uint256 amountPerPeriod;
        uint64 periodSeconds;
        uint64 nextExecutionAt;
        bool active;
    }

    IERC20 public immutable usdc;

    uint256 public nextAgentId;

    mapping(uint256 => AgentConfig) private _agents;
    mapping(uint256 => mapping(address => bool)) private _merchantWhitelist;
    mapping(uint256 => uint256) private _balances;

    // agentId => subId => Subscription. Subscriptions are optional and can be ignored by frontends.
    mapping(uint256 => mapping(uint256 => Subscription)) private _subscriptions;
    mapping(uint256 => uint256) private _nextSubscriptionId;

    event AgentCreated(uint256 indexed agentId, address indexed owner, address indexed agent);
    event AgentUpdated(uint256 indexed agentId, address indexed newAgent);
    event AgentPaused(uint256 indexed agentId, bool active);
    event PolicyLimitsUpdated(uint256 indexed agentId, uint256 dailyLimit, uint256 perTxLimit);
    event MerchantWhitelistUpdated(uint256 indexed agentId, address indexed merchant, bool allowed);
    event Deposit(uint256 indexed agentId, uint256 amount, uint256 newBalance);
    event Withdraw(uint256 indexed agentId, uint256 amount, uint256 newBalance);
    event EmergencyWithdraw(uint256 indexed agentId, uint256 amount);
    event AgentPayment(uint256 indexed agentId, address indexed merchant, uint256 amount, bytes data);
    event DailySpendReset(uint256 indexed agentId);
    event SubscriptionCreated(uint256 indexed agentId, uint256 indexed subscriptionId, address indexed merchant);
    event SubscriptionExecuted(uint256 indexed agentId, uint256 indexed subscriptionId, uint256 amount);
    event SubscriptionStatusChanged(uint256 indexed agentId, uint256 indexed subscriptionId, bool active);

    error AgentWallet__AgentNotFound();
    error AgentWallet__NotAgentOwner();
    error AgentWallet__NotAgent();
    error AgentWallet__PolicyInactive();
    error AgentWallet__MerchantNotAllowed();
    error AgentWallet__PerTxLimitExceeded();
    error AgentWallet__DailyLimitExceeded();
    error AgentWallet__InsufficientBalance();
    error AgentWallet__InvalidAddress();
    error AgentWallet__InvalidAmount();
    error AgentWallet__InvalidLimits();

    constructor(IERC20 usdcToken) Ownable(msg.sender) {
        usdc = usdcToken;
    }

    // -------------------------------------------------------------------------
    // Modifiers & internal helpers
    // -------------------------------------------------------------------------

    modifier agentExists(uint256 agentId) {
        if (_agents[agentId].owner == address(0)) revert AgentWallet__AgentNotFound();
        _;
    }

    modifier onlyAgentOwner(uint256 agentId) {
        if (_agents[agentId].owner != msg.sender) revert AgentWallet__NotAgentOwner();
        _;
    }

    modifier onlyAgent(uint256 agentId) {
        if (_agents[agentId].agent != msg.sender) revert AgentWallet__NotAgent();
        _;
    }

    function _resetIfNeeded(uint256 agentId, Policy storage policy) internal {
        if (block.timestamp >= uint256(policy.lastReset) + 1 days) {
            policy.spentToday = 0;
            policy.lastReset = uint64(block.timestamp);
            emit DailySpendReset(agentId);
        }
    }

    function _validateLimits(uint256 dailyLimit, uint256 perTxLimit) internal pure {
        if (dailyLimit == 0 || perTxLimit == 0) revert AgentWallet__InvalidLimits();
        if (perTxLimit > dailyLimit) revert AgentWallet__InvalidLimits();
    }

    // -------------------------------------------------------------------------
    // Agent lifecycle
    // -------------------------------------------------------------------------

    function createAgent(
        address agentAddress,
        uint256 dailyLimit,
        uint256 perTxLimit
    ) external returns (uint256 agentId) {
        if (agentAddress == address(0)) revert AgentWallet__InvalidAddress();
        _validateLimits(dailyLimit, perTxLimit);

        agentId = ++nextAgentId;

        Policy memory policy = Policy({
            active: true,
            dailyLimit: dailyLimit,
            perTxLimit: perTxLimit,
            spentToday: 0,
            lastReset: uint64(block.timestamp)
        });

        _agents[agentId] = AgentConfig({owner: msg.sender, agent: agentAddress, policy: policy});

        emit AgentCreated(agentId, msg.sender, agentAddress);
    }

    function setAgentAddress(uint256 agentId, address newAgent)
        external
        agentExists(agentId)
        onlyAgentOwner(agentId)
    {
        if (newAgent == address(0)) revert AgentWallet__InvalidAddress();
        _agents[agentId].agent = newAgent;
        emit AgentUpdated(agentId, newAgent);
    }

    // -------------------------------------------------------------------------
    // Funding management
    // -------------------------------------------------------------------------

    function deposit(uint256 agentId, uint256 amount)
        external
        agentExists(agentId)
        onlyAgentOwner(agentId)
        nonReentrant
    {
        if (amount == 0) revert AgentWallet__InvalidAmount();
        bool success = usdc.transferFrom(msg.sender, address(this), amount);
        require(success, "USDC: transferFrom failed");

        _balances[agentId] += amount;
        emit Deposit(agentId, amount, _balances[agentId]);
    }

    function withdraw(uint256 agentId, uint256 amount)
        external
        agentExists(agentId)
        onlyAgentOwner(agentId)
        nonReentrant
    {
        if (amount == 0) revert AgentWallet__InvalidAmount();
        if (_balances[agentId] < amount) revert AgentWallet__InsufficientBalance();

        _balances[agentId] -= amount;
        bool success = usdc.transfer(msg.sender, amount);
        require(success, "USDC: transfer failed");

        emit Withdraw(agentId, amount, _balances[agentId]);
    }

    function emergencyWithdraw(uint256 agentId)
        external
        agentExists(agentId)
        onlyAgentOwner(agentId)
        nonReentrant
    {
        uint256 balance = _balances[agentId];
        _balances[agentId] = 0;

        bool success = usdc.transfer(msg.sender, balance);
        require(success, "USDC: transfer failed");

        emit EmergencyWithdraw(agentId, balance);
    }

    // -------------------------------------------------------------------------
    // Policy management
    // -------------------------------------------------------------------------

    function setPolicyActive(uint256 agentId, bool active)
        external
        agentExists(agentId)
        onlyAgentOwner(agentId)
    {
        _agents[agentId].policy.active = active;
        emit AgentPaused(agentId, active);
    }

    function updateLimits(
        uint256 agentId,
        uint256 newDailyLimit,
        uint256 newPerTxLimit
    ) external agentExists(agentId) onlyAgentOwner(agentId) {
        _validateLimits(newDailyLimit, newPerTxLimit);

        Policy storage policy = _agents[agentId].policy;
        _resetIfNeeded(agentId, policy);

        policy.dailyLimit = newDailyLimit;
        policy.perTxLimit = newPerTxLimit;

        if (policy.spentToday > newDailyLimit) {
            policy.spentToday = newDailyLimit;
        }

        emit PolicyLimitsUpdated(agentId, newDailyLimit, newPerTxLimit);
    }

    function setMerchantWhitelist(
        uint256 agentId,
        address merchant,
        bool allowed
    ) external agentExists(agentId) onlyAgentOwner(agentId) {
        if (merchant == address(0)) revert AgentWallet__InvalidAddress();
        _merchantWhitelist[agentId][merchant] = allowed;
        emit MerchantWhitelistUpdated(agentId, merchant, allowed);
    }

    // -------------------------------------------------------------------------
    // Spending
    // -------------------------------------------------------------------------

    function pay(
        uint256 agentId,
        address merchant,
        uint256 amount,
        bytes calldata data
    ) external agentExists(agentId) onlyAgent(agentId) nonReentrant {
        if (merchant == address(0)) revert AgentWallet__InvalidAddress();
        if (amount == 0) revert AgentWallet__InvalidAmount();

        _processPayment(agentId, merchant, amount, data);
    }

    // -------------------------------------------------------------------------
    // Subscription helpers (optional usage)
    // -------------------------------------------------------------------------

    function createSubscription(
        uint256 agentId,
        address merchant,
        uint256 amountPerPeriod,
        uint64 periodSeconds,
        uint64 firstExecutionAt
    ) external agentExists(agentId) onlyAgentOwner(agentId) returns (uint256 subscriptionId) {
        if (merchant == address(0)) revert AgentWallet__InvalidAddress();
        if (!_merchantWhitelist[agentId][merchant]) revert AgentWallet__MerchantNotAllowed();
        if (amountPerPeriod == 0) revert AgentWallet__InvalidAmount();
        if (periodSeconds < 60) revert AgentWallet__InvalidAmount();

        subscriptionId = ++_nextSubscriptionId[agentId];
        Subscription storage sub = _subscriptions[agentId][subscriptionId];
        sub.merchant = merchant;
        sub.amountPerPeriod = amountPerPeriod;
        sub.periodSeconds = periodSeconds;
        sub.nextExecutionAt = firstExecutionAt == 0 ? uint64(block.timestamp) : firstExecutionAt;
        sub.active = true;

        emit SubscriptionCreated(agentId, subscriptionId, merchant);
    }

    function setSubscriptionStatus(
        uint256 agentId,
        uint256 subscriptionId,
        bool active
    ) external agentExists(agentId) onlyAgentOwner(agentId) {
        Subscription storage sub = _subscriptions[agentId][subscriptionId];
        require(sub.merchant != address(0), "Subscription not found");
        sub.active = active;
        emit SubscriptionStatusChanged(agentId, subscriptionId, active);
    }

    function executeSubscription(uint256 agentId, uint256 subscriptionId, bytes calldata data)
        external
        agentExists(agentId)
        nonReentrant
    {
        Subscription storage sub = _subscriptions[agentId][subscriptionId];
        require(sub.active, "Subscription inactive");
        require(sub.merchant != address(0), "Subscription not found");
        require(block.timestamp >= sub.nextExecutionAt, "Too early");

        sub.nextExecutionAt = uint64(block.timestamp + sub.periodSeconds);

        _processPayment(agentId, sub.merchant, sub.amountPerPeriod, data);

        emit SubscriptionExecuted(agentId, subscriptionId, sub.amountPerPeriod);
    }

    function _processPayment(
        uint256 agentId,
        address merchant,
        uint256 amount,
        bytes calldata data
    ) internal {
        AgentConfig storage config = _agents[agentId];
        Policy storage policy = config.policy;

        _resetIfNeeded(agentId, policy);

        if (!policy.active) revert AgentWallet__PolicyInactive();
        if (!_merchantWhitelist[agentId][merchant]) revert AgentWallet__MerchantNotAllowed();
        if (amount > policy.perTxLimit) revert AgentWallet__PerTxLimitExceeded();
        if (policy.spentToday + amount > policy.dailyLimit) revert AgentWallet__DailyLimitExceeded();
        if (_balances[agentId] < amount) revert AgentWallet__InsufficientBalance();

        _balances[agentId] -= amount;
        policy.spentToday += amount;

        if (data.length == 0) {
            bool success = usdc.transfer(merchant, amount);
            require(success, "USDC: transfer failed");
        } else {
            if (usdc.allowance(address(this), merchant) != 0) {
                require(usdc.approve(merchant, 0), "USDC: reset approve failed");
            }
            require(usdc.approve(merchant, amount), "USDC: approve failed");
            (bool ok, ) = merchant.call(data);
            require(ok, "Merchant call failed");
        }

        emit AgentPayment(agentId, merchant, amount, data);
    }

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------

    function agent(uint256 agentId) external view agentExists(agentId) returns (AgentConfig memory) {
        return _agents[agentId];
    }

    function balanceOf(uint256 agentId) external view agentExists(agentId) returns (uint256) {
        return _balances[agentId];
    }

    function isMerchantWhitelisted(uint256 agentId, address merchant)
        external
        view
        agentExists(agentId)
        returns (bool)
    {
        return _merchantWhitelist[agentId][merchant];
    }

    function spentToday(uint256 agentId) external view agentExists(agentId) returns (uint256) {
        Policy memory policy = _agents[agentId].policy;
        if (block.timestamp >= uint256(policy.lastReset) + 1 days) {
            return 0;
        }
        return policy.spentToday;
    }

    function subscription(uint256 agentId, uint256 subscriptionId)
        external
        view
        agentExists(agentId)
        returns (Subscription memory)
    {
        return _subscriptions[agentId][subscriptionId];
    }

    function nextSubscriptionId(uint256 agentId) external view agentExists(agentId) returns (uint256) {
        return _nextSubscriptionId[agentId];
    }
}


