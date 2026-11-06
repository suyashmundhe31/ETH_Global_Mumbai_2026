// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title RarityShuffle
/// @notice Pure helpers that build a predefined rarity array and shuffle it with an
///         unbiased Fisher–Yates shuffle driven by a single VRF random word.
/// @dev The VRF word is expanded deterministically with keccak256(seed, counter).
///      Each index draw uses rejection sampling so `draw % bound` has no modulo bias.
library RarityShuffle {
    uint8 internal constant RARITY_COUNT = 4;

    error EmptyDistribution();

    /// @notice Builds [COMMON x c0, RARE x c1, EPIC x c2, LEGENDARY x c3].
    function buildRarityArray(uint32[4] memory counts) internal pure returns (uint8[] memory arr) {
        uint256 total = uint256(counts[0]) + counts[1] + counts[2] + counts[3];
        if (total == 0) revert EmptyDistribution();
        arr = new uint8[](total);
        uint256 k;
        for (uint8 r = 0; r < RARITY_COUNT; r++) {
            uint256 c = counts[r];
            for (uint256 i = 0; i < c; i++) {
                arr[k++] = r;
            }
        }
    }

    /// @notice In-place Fisher–Yates (Durstenfeld) shuffle.
    /// @dev For i = n-1 .. 1, pick j uniformly in [0, i] and swap arr[i], arr[j].
    function shuffle(uint8[] memory arr, uint256 seed) internal pure {
        uint256 n = arr.length;
        if (n < 2) return;
        uint256 counter;
        for (uint256 i = n - 1; i > 0; i--) {
            uint256 j;
            (j, counter) = uniform(seed, counter, i + 1);
            (arr[i], arr[j]) = (arr[j], arr[i]);
        }
    }

    /// @notice Returns a uniformly distributed value in [0, bound) using rejection sampling.
    /// @dev Rejects draws below 2^256 mod bound, so the remaining range is an exact multiple of
    ///      bound. The rejection probability is < bound / 2^256 (practically never loops).
    function uniform(uint256 seed, uint256 counter, uint256 bound)
        internal
        pure
        returns (uint256 value, uint256 nextCounter)
    {
        uint256 threshold;
        unchecked {
            // (2^256 - bound) % bound == 2^256 % bound
            threshold = (0 - bound) % bound;
        }
        uint256 draw;
        do {
            draw = uint256(keccak256(abi.encode(seed, counter)));
            unchecked {
                counter++;
            }
        } while (draw < threshold);
        return (draw % bound, counter);
    }

    /// @notice Encodes a rarity array as bytes (1 byte per creature) for compact storage.
    function pack(uint8[] memory arr) internal pure returns (bytes memory out) {
        out = new bytes(arr.length);
        for (uint256 i = 0; i < arr.length; i++) {
            out[i] = bytes1(arr[i]);
        }
    }
}
