import { SqliteAdapter } from './../adapters/sqlite.adapter';
import { MongodbAdapter } from './../adapters/mongodb.adapter';
import { Streamer } from '../streamer';
import seedrandom from 'seedrandom';
import BigNumber from 'bignumber.js';

const CONTRACT_NAME = 'hivelotto';

const ACCOUNT = 'beggars';
const TOKEN_SYMBOL = 'HIVE';
const VALID_CURRENCIES = ['HIVE'];

const COST = 10;
const MAX_ENTRIES = 50;

function rng(previousBlockId, blockId, transactionId) {
    const random = seedrandom(`${previousBlockId}${blockId}${transactionId}`).double();
    const randomRoll = Math.floor(random * 100) + 1;

    return randomRoll;
}

class LottoContract {
    // tslint:disable-next-line: variable-name
    private _instance: Streamer;
    private adapter: MongodbAdapter | SqliteAdapter;

    private blockNumber;
    private blockId;
    private previousBlockId;
    private transactionId;

    private create() {
        this.adapter = this._instance.getAdapter();
    }

    private destroy() {
        // Runs every time unregister is run for this contract
        // Close database connections, write to a database with state, etc
    }

    private updateBlockInfo(blockNumber, blockId, previousBlockId, transactionId) {
        // Lifecycle method which sets block info 
        this.blockNumber = blockNumber;
        this.blockId = blockId;
        this.previousBlockId = previousBlockId;
        this.transactionId = transactionId;
    }

    private async getBalance(): Promise<number> {
        const account = await this._instance['client'].database.getAccounts([ACCOUNT]);

        if (account?.[0]) {
            const balance = (account[0].balance as string).split(' ');
            const amount = balance[0];

            return parseFloat(amount);
        }

        return null;
    }

    async buy(payload, { sender, amount }) {
        const amountTrim = amount.split(' ');
        const amountParsed = parseFloat(amountTrim[0]);
        const amountFormatted = parseFloat(amountTrim[0]).toFixed(3);
        const amountCurrency = amountTrim[1].trim();

        const transaction = await this._instance.getTransaction(this.blockNumber, this.transactionId);
        const verify = await this._instance.verifyTransfer(transaction, sender, ACCOUNT, amount);

        const balance = await this.getBalance();

        if (verify) {
            // User sent an invalid currency
            if (!VALID_CURRENCIES.includes(amountFormatted)) {
                await this._instance.transferHiveTokens(ACCOUNT, sender, amountTrim[0], amountTrim[1], `[Refund] You sent an invalid currency.`);
            }

            // User sent too much
            if (amountParsed > COST) {
                await this._instance.transferHiveTokens(ACCOUNT, sender, amountTrim[0], amountTrim[1], `[Refund] A ticket costs ${COST} HIVE. You sent ${amount}`);
                return;
            }

            // Get database reference from adapter
            const db = this.adapter['db'];

            const collection = db.collection('draws');
        }
    }

    draw() {

    }
}

export default new LottoContract();