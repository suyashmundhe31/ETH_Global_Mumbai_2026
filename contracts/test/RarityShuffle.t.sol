// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RarityShuffle} from "../src/RarityShuffle.sol";

contract RarityShuffleHarness {
    function build(uint32[4] memory counts) external pure returns (uint8[] memory) {
        return RarityShuffle.buildRarityArray(counts);
    }

    function buildAndShuffle(uint32[4] memory counts, uint256 seed) external pure returns (uint8[] memory arr) {
        arr = RarityShuffle.buildRarityArray(counts);
        RarityShuffle.shuffle(arr, seed);
    }

    function uniform(uint256 seed, uint256 counter, uint256 bound) external pure returns (uint256, uint256) {
        return RarityShuffle.uniform(seed, counter, bound);
    }
}

contract RarityShuffleTest is Test {
    RarityShuffleHarness internal h = new RarityShuffleHarness();

    function test_BuildPredefinedArray() public view {
        uint8[] memory arr = h.build([uint32(6), 2, 1, 1]);
        uint8[10] memory expected = [0, 0, 0, 0, 0, 0, 1, 1, 2, 3];
        assertEq(arr.length, 10);
        for (uint256 i = 0; i < 10; i++) {
            assertEq(arr[i], expected[i]);
        }
    }

    function test_RevertWhen_EmptyDistribution() public {
        vm.expectRevert(RarityShuffle.EmptyDistribution.selector);
        h.build([uint32(0), 0, 0, 0]);
    }

    function testFuzz_ShuffleIsPermutation(uint8 c, uint8 r, uint8 e, uint8 l, uint256 seed) public view {
        vm.assume(uint256(c) + r + e + l > 0);
        uint8[] memory arr = h.buildAndShuffle([uint32(c), r, e, l], seed);
        uint256[4] memory seen;
        for (uint256 i = 0; i < arr.length; i++) {
            assertLt(arr[i], 4);
            seen[arr[i]]++;
        }
        assertEq(seen[0], c);
        assertEq(seen[1], r);
        assertEq(seen[2], e);
        assertEq(seen[3], l);
    }

    function testFuzz_UniformWithinBound(uint256 seed, uint256 counter, uint256 bound) public view {
        bound = _bound(bound, 1, type(uint256).max);
        counter = _bound(counter, 0, type(uint128).max);
        (uint256 v, uint256 next) = h.uniform(seed, counter, bound);
        assertLt(v, bound);
        assertGt(next, counter);
    }

    function test_ShuffleDeterministicForSeed() public view {
        uint8[] memory a = h.buildAndShuffle([uint32(6), 2, 1, 1], 42);
        uint8[] memory b = h.buildAndShuffle([uint32(6), 2, 1, 1], 42);
        assertEq(keccak256(abi.encode(a)), keccak256(abi.encode(b)));
    }

    /// Rough uniformity check: the LEGENDARY position over many seeds should hit every slot.
    function test_LegendaryPositionCoversAllSlots() public view {
        bool[10] memory hit;
        for (uint256 s = 0; s < 200; s++) {
            uint8[] memory arr = h.buildAndShuffle([uint32(6), 2, 1, 1], s);
            for (uint256 i = 0; i < 10; i++) {
                if (arr[i] == 3) hit[i] = true;
            }
        }
        for (uint256 i = 0; i < 10; i++) {
            assertTrue(hit[i], "slot never chosen");
        }
    }
}
