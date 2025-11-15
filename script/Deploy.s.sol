// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {IERC20} from "../src/AgentWallet.sol";

contract DeployScript is Script {
    function run() external returns (AgentWallet) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address usdcAddress = vm.envAddress("USDC_ADDRESS");
        
        vm.startBroadcast(deployerPrivateKey);
        
        AgentWallet wallet = new AgentWallet(IERC20(usdcAddress));
        
        console.log("AgentWallet deployed at:", address(wallet));
        
        vm.stopBroadcast();
        
        return wallet;
    }
}

