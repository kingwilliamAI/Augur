// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * The fee split, as a contract rather than as a promise.
 *
 * Every trade on a pons curve pays a fee, and the launch names one address to receive it. For $AUGUR
 * that address was a wallet, which means the arrangement written on the site was a sentence somebody
 * had to be trusted to keep. This replaces the sentence. Point the launch's fee recipient here and
 * the money can only leave in three directions, in shares fixed when the contract was deployed.
 *
 * What it deliberately does not have, and cannot be given later:
 *
 *   - an owner, a pauser, or an upgrade path;
 *   - a setter for any destination or any share;
 *   - a sweep, a rescue, or any way to send the balance anywhere else.
 *
 * Everything is immutable and public, so the split can be read straight off the chain and compared
 * with what the page says. Changing any of it means deploying a new contract and pointing the
 * launch's fee recipient at it, which is a transaction anybody can see.
 *
 * `release` is permissionless on purpose. Only the three destinations can receive anything, so
 * letting anyone trigger the payout costs nothing and removes the last thing that could stall it.
 *
 * Rounding goes to holders. Integer division leaves at most two wei on the table and it has to go
 * somewhere; sending it to the half that is not ours is the only choice that needs no explaining.
 */
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract FeeSplitter {
    /// The chain's own currency, in the asset field of a Split.
    address private constant NATIVE = address(0);
    uint256 private constant DENOMINATOR = 10_000;

    address public immutable server;
    address public immutable holders;
    address public immutable buyback;

    uint16 public immutable serverBps;
    uint16 public immutable holdersBps;
    uint16 public immutable buybackBps;

    event Received(address indexed from, uint256 amount);
    event Split(address indexed asset, uint256 total, uint256 toServer, uint256 toHolders, uint256 toBuyback);

    error SharesMustSumToOne();
    error ZeroAddress();
    error NothingToSplit();
    error PayoutFailed(address to);

    constructor(
        address server_,
        address holders_,
        address buyback_,
        uint16 serverBps_,
        uint16 holdersBps_,
        uint16 buybackBps_
    ) {
        if (server_ == address(0) || holders_ == address(0) || buyback_ == address(0)) revert ZeroAddress();
        if (uint256(serverBps_) + holdersBps_ + buybackBps_ != DENOMINATOR) revert SharesMustSumToOne();

        server = server_;
        holders = holders_;
        buyback = buyback_;
        serverBps = serverBps_;
        holdersBps = holdersBps_;
        buybackBps = buybackBps_;
    }

    /// Fees arrive here by being claimed out of the pons escrow, which sends to the recipient.
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /**
     * Splits everything the contract holds of the chain's own currency.
     *
     * Balance-based rather than per-deposit: a fee that arrives while a payout is in flight is not
     * lost, it is simply part of the next release. That also makes the contract indifferent to how
     * the escrow pays out, which is the part of pons this cannot control.
     */
    function release() external {
        uint256 total = address(this).balance;
        if (total == 0) revert NothingToSplit();

        uint256 toServer = (total * serverBps) / DENOMINATOR;
        uint256 toBuyback = (total * buybackBps) / DENOMINATOR;
        uint256 toHolders = total - toServer - toBuyback;

        _payNative(server, toServer);
        _payNative(buyback, toBuyback);
        _payNative(holders, toHolders);

        emit Split(NATIVE, total, toServer, toHolders, toBuyback);
    }

    /**
     * The same split for a fee that arrived as a token.
     *
     * About half of pons launches are quoted in something other than the chain's currency, and a
     * fee paid in that asset would otherwise sit here forever. The three destinations are the same,
     * so this adds a currency rather than a direction.
     */
    function releaseToken(address asset) external {
        if (asset == NATIVE) revert ZeroAddress();
        uint256 total = IERC20(asset).balanceOf(address(this));
        if (total == 0) revert NothingToSplit();

        uint256 toServer = (total * serverBps) / DENOMINATOR;
        uint256 toBuyback = (total * buybackBps) / DENOMINATOR;
        uint256 toHolders = total - toServer - toBuyback;

        _payToken(asset, server, toServer);
        _payToken(asset, buyback, toBuyback);
        _payToken(asset, holders, toHolders);

        emit Split(asset, total, toServer, toHolders, toBuyback);
    }

    function _payNative(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert PayoutFailed(to);
    }

    function _payToken(address asset, address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) = asset.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        // A token that returns nothing on success is common enough that treating an empty return as
        // a failure would strand the fee; anything else that is not `true` is a failure.
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert PayoutFailed(to);
    }
}
