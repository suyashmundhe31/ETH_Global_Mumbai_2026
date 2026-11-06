// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReceiver} from "@chainlink/contracts/src/v0.8/keystone/interfaces/IReceiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ReceiverTemplate
/// @notice Base for contracts that receive Chainlink CRE workflow reports through the KeystoneForwarder.
/// @dev Vendored and adapted from Chainlink's CRE ReceiverTemplate. Differences: the forwarder is required
/// (non-zero) and owner-settable. Workflow id / name / owner checks are optional (zero = skip).
/// Metadata layout from the forwarder: abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner).
abstract contract ReceiverTemplate is IReceiver, IERC165, Ownable {
  address private s_forwarder;
  bytes32 private s_expectedWorkflowId;
  bytes10 private s_expectedWorkflowName;
  address private s_expectedAuthor;

  error ZeroForwarder();
  error InvalidMetadata();
  error InvalidSender(address sender, address expected);
  error InvalidWorkflowId(bytes32 received, bytes32 expected);
  error InvalidWorkflowName(bytes10 received, bytes10 expected);
  error InvalidAuthor(address received, address expected);

  event ForwarderSet(address forwarder);
  event ExpectedWorkflowSet(bytes32 workflowId, bytes10 workflowName, address author);

  constructor(address forwarder) Ownable(msg.sender) {
    _setForwarder(forwarder);
  }

  /// @inheritdoc IReceiver
  function onReport(bytes calldata metadata, bytes calldata report) external override {
    if (msg.sender != s_forwarder) revert InvalidSender(msg.sender, s_forwarder);

    if (s_expectedWorkflowId != bytes32(0) || s_expectedWorkflowName != bytes10(0) || s_expectedAuthor != address(0)) {
      (bytes32 workflowId, bytes10 workflowName, address author) = _decodeMetadata(metadata);
      if (s_expectedWorkflowId != bytes32(0) && workflowId != s_expectedWorkflowId) {
        revert InvalidWorkflowId(workflowId, s_expectedWorkflowId);
      }
      if (s_expectedWorkflowName != bytes10(0) && workflowName != s_expectedWorkflowName) {
        revert InvalidWorkflowName(workflowName, s_expectedWorkflowName);
      }
      if (s_expectedAuthor != address(0) && author != s_expectedAuthor) {
        revert InvalidAuthor(author, s_expectedAuthor);
      }
    }

    _processReport(report);
  }

  function setForwarder(address forwarder) external onlyOwner {
    _setForwarder(forwarder);
  }

  /// @notice Pin reports to one workflow. Pass zero for any field to skip that check.
  function setExpectedWorkflow(bytes32 workflowId, bytes10 workflowName, address author) external onlyOwner {
    s_expectedWorkflowId = workflowId;
    s_expectedWorkflowName = workflowName;
    s_expectedAuthor = author;
    emit ExpectedWorkflowSet(workflowId, workflowName, author);
  }

  function getForwarder() external view returns (address) {
    return s_forwarder;
  }

  function getExpectedWorkflow() external view returns (bytes32 workflowId, bytes10 workflowName, address author) {
    return (s_expectedWorkflowId, s_expectedWorkflowName, s_expectedAuthor);
  }

  /// @inheritdoc IERC165
  function supportsInterface(bytes4 interfaceId) public pure virtual override returns (bool) {
    return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
  }

  /// @dev Handle the workflow's ABI-encoded report.
  function _processReport(bytes calldata report) internal virtual;

  function _setForwarder(address forwarder) private {
    if (forwarder == address(0)) revert ZeroForwarder();
    s_forwarder = forwarder;
    emit ForwarderSet(forwarder);
  }

  function _decodeMetadata(
    bytes memory metadata
  ) internal pure returns (bytes32 workflowId, bytes10 workflowName, address author) {
    // 32 (length word) | workflowId 32 | workflowName 10 | author 20
    if (metadata.length < 62) revert InvalidMetadata();
    assembly {
      workflowId := mload(add(metadata, 32))
      // Keep only the top 10 bytes so the bytes10 has no dirty low-order bits.
      workflowName := shl(176, shr(176, mload(add(metadata, 64))))
      author := shr(96, mload(add(metadata, 74)))
    }
  }
}
