// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReceiverTemplate} from "./ReceiverTemplate.sol";
import {CatchManager} from "./CatchManager.sol";

/// @title CatchReceiver
/// @notice CRE entry point (proxy pattern from the CRE docs). The KeystoneForwarder verifies the DON
///         signatures and calls onReport; this contract forwards the verdict to CatchManager.
/// @dev Kept separate from CatchManager because ReceiverTemplate uses OpenZeppelin Ownable while
///      VRFConsumerBaseV2Plus uses Chainlink ConfirmedOwner; both define owner()/onlyOwner.
///      Report: abi.encode(uint64 chainSelector, uint8 reportType, bytes payload)
///        1 CATCH  payload = abi.encode(uint256 attemptId, bool approved, uint256 nullifier)
///        2 REDEEM payload = abi.encode(uint256 creatureId, bool approved, bytes sealedCode)
contract CatchReceiver is ReceiverTemplate {
    uint8 public constant REPORT_CATCH = 1;
    uint8 public constant REPORT_REDEEM = 2;

    CatchManager public immutable catchManager;
    uint64 public immutable expectedChainSelector;

    error UnexpectedChainSelector(uint64 received, uint64 expected);
    error UnknownReportType(uint8 reportType);

    constructor(address forwarder, CatchManager manager, uint64 chainSelector) ReceiverTemplate(forwarder) {
        catchManager = manager;
        expectedChainSelector = chainSelector;
    }

    function _processReport(bytes calldata report) internal override {
        (uint64 chainSelector, uint8 reportType, bytes memory payload) = abi.decode(report, (uint64, uint8, bytes));
        // Cross-chain replay protection, as recommended by the CRE docs.
        if (chainSelector != expectedChainSelector) revert UnexpectedChainSelector(chainSelector, expectedChainSelector);
        // Same-chain replays are harmless: CatchManager ignores verdicts that no longer match its state.
        if (reportType == REPORT_CATCH) {
            (uint256 attemptId, bool approved, uint256 nullifier) = abi.decode(payload, (uint256, bool, uint256));
            catchManager.onVerification(attemptId, approved, nullifier);
        } else if (reportType == REPORT_REDEEM) {
            (uint256 creatureId, bool approved, bytes memory sealedCode) = abi.decode(payload, (uint256, bool, bytes));
            catchManager.onRedeemVerified(creatureId, approved, sealedCode);
        } else {
            revert UnknownReportType(reportType);
        }
    }
}
