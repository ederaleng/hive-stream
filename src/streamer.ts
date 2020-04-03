import { Client } from 'dsteem';
import fs from 'fs';
import { Utils } from './utils';
import { Config, ConfigInterface } from './config';

interface Contract {
    name: string;
    contract: any;
}

export class Streamer {
    private customJsonSubscriptions: any[] = [];
    private customJsonIdSubscriptions: any[] = [];
    private commentSubscriptions: any[] = [];
    private postSubscriptions: any[] = [];
    private transferSubscriptions: any[] = [];

    private attempts = 0;

    private config: ConfigInterface = Config;
    private client: Client;

    private username: string;
    private postingKey: string;
    private activeKey: string;

    private blockNumberTimeout: NodeJS.Timeout = null;
    private lastBlockNumber: number = 0;

    private blockId: string;
    private previousBlockId: string;
    private transactionId: string;
    private disableAllProcessing = false;

    private contracts: Contract[] = [];

    private utils = Utils;

    constructor(userConfig: Partial<ConfigInterface> = {}) {
        this.config = Object.assign(Config, userConfig);

        this.lastBlockNumber = this.config.LAST_BLOCK_NUMBER;

        this.username = this.config.USERNAME;
        this.postingKey = this.config.POSTING_KEY;
        this.activeKey = this.config.ACTIVE_KEY;

        this.client = new Client(this.config.API_NODES[0], { timeout: 2000 });
    }

    public registerContract(name: string, contract: any) {
        // Call the contract create lifecycle method if it exists
        if (contract && typeof contract['create'] !== 'undefined') {
            contract.create();
        }

        // Store a reference to the client
        contract['_client'] = this.client;

        const storedReference: Contract = { name, contract };

        // Push the contract reference to be called later on
        this.contracts.push(storedReference);

        return this;
    }

    public unregisterContract(name: string) {
        // Find the registered contract by it's ID
        const contractIndex = this.contracts.findIndex(c => c.name === name);

        if (contractIndex >= 0) {
            // Get the contract itself
            const contract = this.contracts.find(c => c.name === name);

            // Call the contract destroy lifecycle method if it exists
            if (contract && typeof contract.contract['destroy'] !== 'undefined') {
                contract.contract.destroy();
            }

            // Remove the contract
            this.contracts.splice(contractIndex, 1);
        }
    }

    /**
     * setConfig
     *
     * Allows specific configuration settings to be overridden
     *
     * @param config
     */
    public setConfig(config: Partial<ConfigInterface>) {
        Object.assign(this.config, config);

        // Set keys and username incase they have changed
        this.username = this.config.USERNAME;
        this.postingKey = this.config.POSTING_KEY;
        this.activeKey = this.config.ACTIVE_KEY;

        return this;
    }

    /**
     * Start
     *
     * Starts the streamer bot to get blocks from the Hive API
     *
     */
    public start(): void {
        if (this.config.DEBUG_MODE) {
            console.log('Starting to stream the Hive blockchain');
        }

        this.disableAllProcessing = false;

        // Do we have any previously saved state to load?
        if (fs.existsSync('hive-stream.json')) {
            // Parse the object data from the JSON state file
            const state = JSON.parse(
                (fs.readFileSync('hive-stream.json') as unknown) as string
            );

            if (state.lastBlockNumber) {
                this.lastBlockNumber = state.lastBlockNumber;
            }

            if (this.config.DEBUG_MODE) {
                console.log(`Restoring state from file`);
            }
        }

        // Kicks off the blockchain streaming and operation parsing
        this.getBlock();
    }

    /**
     * Stop
     *
     * Stops the streamer from running
     */
    public stop(): void {
        this.disableAllProcessing = true;

        if (this.blockNumberTimeout) {
            clearTimeout(this.blockNumberTimeout);
        }
    }

    private async getBlock(): Promise<void> {
        try {
            // Load global properties from the Hive API
            const props = await this.client.database.getDynamicGlobalProperties();

            // We have no props, so try loading them again.
            if (!props) {
                this.blockNumberTimeout = setTimeout(() => {
                    this.getBlock();
                }, this.config.BLOCK_CHECK_INTERVAL);
                return;
            }

            // If the block number we've got is zero
            // set it to the last irreversible block number
            if (this.lastBlockNumber === 0) {
                this.lastBlockNumber = props.head_block_number - 1;
            }

            if (this.config.DEBUG_MODE) {
                console.log(`Head block number: `, props.head_block_number);
                console.log(`Last block number: `, this.lastBlockNumber);
            }

            const BLOCKS_BEHIND = parseInt(this.config.BLOCKS_BEHIND_WARNING as any, 10);

            // We are more than 25 blocks behind, uh oh, we gotta catch up
            if (props.head_block_number >= (this.lastBlockNumber + BLOCKS_BEHIND) && this.config.DEBUG_MODE) {
                console.log(`We are more than ${BLOCKS_BEHIND} blocks behind ${props.head_block_number}, ${(this.lastBlockNumber + BLOCKS_BEHIND)}`);
            }

            if (!this.disableAllProcessing) {
                await this.loadBlock(this.lastBlockNumber + 1);
            }

            // Storing timeout allows us to clear it, as this just calls itself
            if (!this.disableAllProcessing) {
                this.blockNumberTimeout = setTimeout(() => { this.getBlock(); }, this.config.BLOCK_CHECK_INTERVAL);
            }
        } catch (e) {
            const message = e.message.toLowerCase();

            if (message.includes('network') || message.includes('enotfound') && this.attempts < this.config.API_NODES.length - 1) {
                if (this.config.DEBUG_MODE) {
                    // Increase by one as we are already using the first supplied API node URL
                    console.log(`There was an error, trying new node. Attempt number: ${this.attempts + 1}`);

                    console.log(`Timeout value based on attempt count: ${2000 * this.attempts}`);
                    console.log(`Trying node ${this.config.API_NODES[this.attempts + 1]}`);
                }

                this.client = new Client(this.config.API_NODES[this.attempts + 1], {
                    timeout: 2000 * this.attempts
                });

                this.getBlock();

                this.attempts++;
            }
        }
    }

    // Takes the block from Hive and allows us to work with it
    private async loadBlock(blockNumber: number): Promise<void> {
        // Load the block itself from the Hive API
        const block = await this.client.database.getBlock(blockNumber);

        // The block doesn't exist, wait and try again
        if (!block) {
            await Utils.sleep(this.config.BLOCK_CHECK_INTERVAL);
            return;
        }

        // Get the block date and time
        const blockTime = new Date(`${block.timestamp}`);

        this.blockId = block.block_id;
        this.previousBlockId = block.previous;
        this.transactionId = block.transaction_ids[1];
        // Loop over all transactions in the block
        for (const [i, transaction] of Object.entries(block.transactions)) {
            // Loop over operations in the block
            for (const [opIndex, op] of Object.entries(transaction.operations)) {
                // For every operation, process it
                await this.processOperation(
                    op,
                    blockNumber,
                    block.block_id,
                    block.previous,
                    block.transaction_ids[i],
                    blockTime
                );
            }
        }

        this.lastBlockNumber = blockNumber;
        this.saveStateToDisk();
    }

    public processOperation(
        op: any,
        blockNumber: number,
        blockId: string,
        prevBlockId: string,
        trxId: string,
        blockTime: Date
    ): void {
        // Operation is a "comment" which could either be a post or comment
        if (op[0] === 'comment') {
            // This is a post
            if (op[1].parent_author === '') {
                this.postSubscriptions.forEach(sub => {
                    sub.callback(
                        op[1],
                        blockNumber,
                        blockId,
                        prevBlockId,
                        trxId,
                        blockTime
                    );
                });
                // This is a comment
            } else {
                this.commentSubscriptions.forEach(sub => {
                    sub.callback(
                        op[1],
                        blockNumber,
                        blockId,
                        prevBlockId,
                        trxId,
                        blockTime
                    );
                });
            }
        }

        // This is a transfer
        if (op[0] === 'transfer') {
            const sender = op[1]?.from;
            const amount = op[1]?.amount;

            const json = Utils.jsonParse(op[1].memo);

            if (json && json?.hiveContract) {
                // Pull out details of contract
                const { name, action, payload } = json.hiveContract;

                // Do we have a contract that matches the name in the payload?
                const contract = this.contracts.find(c => c.name === name);

                if (contract) {
                    if (contract?.contract?.updateBlockInfo) {
                        contract.contract.updateBlockInfo(blockNumber, blockId, prevBlockId, trxId);
                    }

                    if (contract?.contract[action]) {
                        contract.contract[action](payload, { sender, amount }, undefined);
                    }
                }
            }

            this.transferSubscriptions.forEach(sub => {
                if (sub.account === op[1].to) {
                    sub.callback(
                        op[1],
                        blockNumber,
                        blockId,
                        prevBlockId,
                        trxId,
                        blockTime
                    );
                }
            });
        }

        // This is a custom JSON operation
        if (op[0] === 'custom_json') {
            let isSignedWithActiveKey = false;
            let sender;
            
            const id = op[1]?.id;

            if (op[1]?.required_auths?.length > 0) {
                sender = op[1].required_auths[0];
                isSignedWithActiveKey = true;
            } else if (op[1]?.required_posting_auths?.length > 0) {
                sender = op[1].required_posting_auths[0];
                isSignedWithActiveKey = false;
            }

            const json = Utils.jsonParse(op[1].json);

            if (json && json.hiveContract) {
                // Pull out details of contract
                const { name, action, payload } = json.hiveContract;

                // Do we have a contract that matches the name in the payload?
                const contract = this.contracts.find(c => c.name === name);

                if (contract) {
                    if (contract?.contract?.updateBlockInfo) {
                        contract.contract.updateBlockInfo(blockNumber, blockId, prevBlockId, trxId);
                    }

                    if (contract?.contract[action]) {
                        contract.contract[action](payload, { sender, isSignedWithActiveKey }, id);
                    }
                }
            }

            this.customJsonSubscriptions.forEach(sub => {
                sub.callback(
                    op[1],
                    { sender, isSignedWithActiveKey },
                    blockNumber,
                    blockId,
                    prevBlockId,
                    trxId,
                    blockTime
                );
            });

            this.customJsonIdSubscriptions.forEach(sub => {
                const byId = this.customJsonIdSubscriptions.find(s => s.id === op[1].id);

                if (byId) {
                    sub.callback(
                        op[1],
                        { sender, isSignedWithActiveKey },
                        blockNumber,
                        blockId,
                        prevBlockId,
                        trxId,
                        blockTime
                    ); 
                }
            });
        }
    }

    public async saveStateToDisk(): Promise<void> {
        const state = {
            lastBlockNumber: this.lastBlockNumber
        };

        fs.writeFile('hive-stream.json', JSON.stringify(state), err => {
            if (err) {
                console.error(err);
            }
        });
    }

    public transferHiveTokens(
        from: string,
        to: string,
        amount: string,
        symbol: string,
        memo: string = ''
    ) {
        return Utils.transferHiveTokens(
            this.client,
            this.config,
            from,
            to,
            amount,
            symbol,
            memo
        );
    }

    public upvote(
        votePercentage: string = '100.0',
        username: string,
        permlink: string
    ) {
        return Utils.upvote(
            this.client,
            this.config,
            this.username,
            votePercentage,
            username,
            permlink
        );
    }

    public downvote(
        votePercentage: string = '100.0',
        username: string,
        permlink: string
    ) {
        return Utils.downvote(
            this.client,
            this.config,
            this.username,
            votePercentage,
            username,
            permlink
        );
    }

    public getTransaction(blockNumber: number, transactionId: string) {
        return Utils.getTransaction(this.client, blockNumber, transactionId);
    }

    public onComment(callback: any): void {
        this.commentSubscriptions.push({
            callback
        });
    }

    public onPost(callback: any): void {
        this.postSubscriptions.push({
            callback
        });
    }

    public onTransfer(account: string, callback: () => void): void {
        this.transferSubscriptions.push({
            account,
            callback
        });
    }

    public onCustomJson(callback: any): void {
        this.customJsonSubscriptions.push({ callback }); 
    }

    public onCustomJsonId(callback: any, id: string): void {
        this.customJsonIdSubscriptions.push({ callback, id });
    }
}
