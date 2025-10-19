pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract DeFiArenaFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    struct Match {
        address player1;
        address player2;
        euint32 player1Stake;
        euint32 player2Stake;
        euint32 player1Score;
        euint32 player2Score;
        bool isSettled;
    }

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 matchCount;
        mapping(uint256 => Match) matches;
    }

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    mapping(uint256 => DecryptionContext) public decryptionContexts;
    mapping(uint256 => Batch) public batches;
    uint256 public currentBatchId;
    uint256 public cooldownSeconds;
    bool public paused;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event MatchSubmitted(uint256 indexed batchId, uint256 indexed matchId, address indexed player1, address player2);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256[] results);

    error NotOwner();
    error NotProvider();
    error PausedError();
    error CooldownActive();
    error BatchClosedOrDoesNotExist();
    error InvalidBatchState();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error MatchAlreadySettled();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60;
        currentBatchId = 1;
        _openBatch(currentBatchId);
    }

    function transferOwnership(address newOwner) public onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) public onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) public onlyOwner {
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function pause() public onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() public onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) public onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openBatch() public onlyOwner {
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function closeBatch(uint256 batchId) public onlyOwner {
        if (batchId != currentBatchId) revert InvalidBatchState();
        Batch storage batch = batches[batchId];
        if (!batch.isOpen) revert BatchClosedOrDoesNotExist();
        batch.isOpen = false;
        emit BatchClosed(batchId);
    }

    function submitMatch(
        uint256 batchId,
        address player1,
        address player2,
        euint32 player1Stake,
        euint32 player2Stake
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (batchId != currentBatchId) revert InvalidBatchState();
        Batch storage batch = batches[batchId];
        if (!batch.isOpen) revert BatchClosedOrDoesNotExist();

        uint256 matchId = batch.matchCount;
        batch.matches[matchId] = Match({
            player1: player1,
            player2: player2,
            player1Stake: player1Stake,
            player2Stake: player2Stake,
            player1Score: euint32(0),
            player2Score: euint32(0),
            isSettled: false
        });
        batch.matchCount++;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit MatchSubmitted(batchId, matchId, player1, player2);
    }

    function submitEncryptedScores(
        uint256 batchId,
        uint256 matchId,
        euint32 player1Score,
        euint32 player2Score
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (batchId != currentBatchId) revert InvalidBatchState();
        Batch storage batch = batches[batchId];
        if (!batch.isOpen) revert BatchClosedOrDoesNotExist();
        if (matchId >= batch.matchCount) revert InvalidBatchState();

        Match storage match = batch.matches[matchId];
        if (match.isSettled) revert MatchAlreadySettled();

        match.player1Score = player1Score;
        match.player2Score = player2Score;
        match.isSettled = true;

        lastSubmissionTime[msg.sender] = block.timestamp;
    }

    function requestBatchSettlement(uint256 batchId) external onlyProvider whenNotPaused checkDecryptionCooldown {
        if (batchId != currentBatchId) revert InvalidBatchState();
        Batch storage batch = batches[batchId];
        if (batch.isOpen) revert InvalidBatchState();

        uint256 numMatches = batch.matchCount;
        if (numMatches == 0) revert InvalidBatchState();

        bytes32[] memory cts = new bytes32[](numMatches * 2);
        for (uint256 i = 0; i < numMatches; i++) {
            Match storage match = batch.matches[i];
            cts[i * 2] = match.player1Score.toBytes32();
            cts[i * 2 + 1] = match.player2Score.toBytes32();
        }

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        DecryptionContext storage ctx = decryptionContexts[requestId];

        Batch storage batch = batches[ctx.batchId];
        uint256 numMatches = batch.matchCount;
        if (numMatches == 0) revert InvalidBatchState();

        bytes32[] memory currentCts = new bytes32[](numMatches * 2);
        for (uint256 i = 0; i < numMatches; i++) {
            Match storage match = batch.matches[i];
            currentCts[i * 2] = match.player1Score.toBytes32();
            currentCts[i * 2 + 1] = match.player2Score.toBytes32();
        }
        bytes32 currentHash = _hashCiphertexts(currentCts);
        if (currentHash != ctx.stateHash) revert StateMismatch();

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256[] memory results = new uint256[](numMatches * 2);
        for (uint256 i = 0; i < numMatches * 2; ) {
            results[i] = abi.decode(cleartexts, (uint32));
            cleartexts = cleartexts[32:];
            unchecked { i++; }
        }

        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, results);
    }

    function _openBatch(uint256 batchId) internal {
        batches[batchId] = Batch({
            id: batchId,
            isOpen: true,
            matchCount: 0
        });
        emit BatchOpened(batchId);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }
}