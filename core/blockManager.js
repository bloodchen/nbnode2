const { DEF } = require('./def');
const { Util } = require('./util')
var stringify = require('json-stable-stringify');
const { default: axios } = require('axios');
const CONFIG = require('./config').CONFIG
let wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let objLen = obj => Object.keys(obj).length
class BlockMgr {
    constructor(indexers) {
        this.indexers = indexers
        this.nodePool = {}
        this.blockPool = {}
        this.height = 0
        this.signedBlock = -1
        this.uBlock = null //next unconfirmed block
        this.db = indexers.db
        this._canResolve = true
        this.removeTX = []
        //this.indexers.resolver.addController(this)
    }
    async createBlock(height, ntx = 10) {
        const db = this.db
        let preBlock = null, time = 0
        if (height > 0) {
            const b = db.getBlock(height - 1)
            if (b) {
                preBlock = b && JSON.parse(b.body)
                preBlock.hash = b.hash
            }
        }
        if (preBlock) {
            const lastTx = preBlock.txs[preBlock.txs.length - 1]
            time = lastTx.txTime
            if (!this.lastBlockTime) this.lastBlockTime = time
            if (this.lastBlockTime < time) {
                this.lastBlockTime = time
                this.removeTX = [] // used to remove the txs that's already in previous Block
            }
            for (const tx of preBlock.txs) {
                if (tx.txTime == time) this.removeTX.push(tx.txid)
            }
        }
        const txs = db.getTransactions({ time, limit: DEF.MAX_BLOCK_LENGTH, remove: this.removeTX })
        if (!txs || txs.length == 0) {
            //return preBlock
            return null
        }
        const merkel = await this.computeMerkel(txs)
        const block = { version: DEF.BLOCK_VER, height: height, merkel, txs, preHash: preBlock ? preBlock.hash : null }
        //console.log(block)
        block.hash = await Util.dataHash(stringify(block))
        console.log("new block created. hash:", block.hash)
        return block
    }
    async computeMerkel(txs) {
        let lastHash = null
        for (const tx of txs) {
            const hash = await Util.dataHash(tx.txid + tx.bytes.toString("hex") + tx.txTime)
            lastHash = lastHash ? await Util.dataHash(hash + lastHash) : hash
            //console.log("txid:", tx.txid, " merkel:", lastHash)
            delete tx.bytes
        }
        return lastHash
    }
    canResolve() {
        const ret = (this.uBlock === null) && this._canResolve
        return ret
    }
    async onReceiveBlock(nodeKey, uBlock) {
        const { Nodes } = this.indexers
        const { block, sigs } = uBlock
        if (block.version != DEF.BLOCK_VER) return
        //console.log("got block height:", block.height, " from:", nodeKey, "sigs:", sigs)
        if (!this.nodePool[nodeKey]) this.nodePool[nodeKey] = {}

        if (!this.uBlock) {
            this.nodePool[nodeKey].uBlock = uBlock
            return
        }
        let poolNode = this.nodePool[nodeKey]
        if (sigs && block.height === this.height && (JSON.stringify(sigs) !== JSON.stringify(poolNode.sigs))) {
            poolNode = this.nodePool[nodeKey]
            poolNode.sigs = sigs
            delete block.hash
            const hash = await Util.dataHash(stringify(block))
            block.hash = poolNode.hash = hash
            //check sender's sig
            const sigSender = sigs[nodeKey]
            if (await Util.bitcoinVerify(nodeKey, hash, sigSender) == false) return
            if (this.uBlock && this.uBlock.block.hash === hash) { //same as my block

                if (!sigs[Nodes.thisNode.key]) { //add my sig
                    const sig = await Util.bitcoinSign(CONFIG.key, hash)
                    sigs[Nodes.thisNode.key] = sig
                }
                if (objLen(this.uBlock.sigs) < objLen(sigs)) {
                    this.uBlock = uBlock
                }
            }
        }
        this.nodePool[nodeKey].uBlock = uBlock
        // block && console.log("got new block:", block.height, block.hash, this.blockPool[block.hash]?.count, "from:", nodeKey)
    }
    async downloadBlocks(from, to, url) {
        let ret = false, resetDB = false
        this._canResolve = false
        try {
            console.log(`downloading block ${from}-${to} from: ${url}`)
            const res = await axios.get(url + `/api/getBlocks?from=${from}&&to=${to}`)
            if (res.data) {
                for (const blockItem of res.data) {
                    let block = JSON.parse(blockItem.body)
                    if (block.version != DEF.BLOCK_VER) continue
                    const sigs = JSON.parse(blockItem.sigs)
                    block.hash = blockItem.hash
                    //if (objLen(block.sigs) < DEF.CONSENSUE_COUNT) return false
                    let tempBlock = await this.createBlock(block.height)
                    const merkel = tempBlock ? tempBlock.merkel : null
                    if (merkel != block.merkel) { //refetch all txs in the block
                        const btx = await axios.get(url + "/api/queryTX?height=" + block.height)
                        if (btx.data) {
                            this.db.deleteTxs(btx.txs)
                            for (const ftx of btx.data) {
                                this.db.addFullTx({ txid: ftx.txid, rawtx: ftx.rawtx, time: ftx.time, txTime: ftx.txTime, oDataRecord: ftx.oDataRecord, chain: ftx.chain, replace: true })
                            }
                            tempBlock = await this.createBlock(block.height)
                            if (tempBlock.merkel != block.merkel) {
                                console.log("found")
                            }
                            if (merkel)
                                resetDB = true //reset domain db if there are conflicts
                        }
                    }
                    this.db.saveBlock({ sigs, block })
                    ret = true
                }
                if (resetDB) {
                    console.log("will call resetDB ")
                    //this.db.resetDB("domain")
                }
            }
        } catch (e) {
            return false
        } finally {
            this._canResolve = true
        }
        return ret
    }
    async onNewTx() {
        this.hasNewTX = true
        this.uBlock = null
    }
    async run() {
        while (true) {
            const { Nodes } = this.indexers
            if (this.hasNewTX) {
                this.hasNewTX = false
                await wait(DEF.BLOCK_TIME)
                continue
            }
            const bl = this.db.getLastBlock()
            this.height = bl ? bl.height + 1 : 0
            if (Nodes.isProducer()) { //create and broadcast blocks
                if (!this.uBlock) { //wait the block to confirm
                    let block = await this.createBlock(this.height)
                    if (block) {
                        this.height = block.height
                        if (block.txs.length < 100) { //less than 100, wait for a while, give time for new tx to broadcast
                            await wait(DEF.BLOCK_TIME * 2)
                            block = await this.createBlock(this.height)
                        }
                        const sig = await Util.bitcoinSign(CONFIG.key, block.hash)
                        const uBlock = { sigs: {}, block }
                        uBlock.sigs[Nodes.thisNode.key] = sig
                        this.uBlock = uBlock
                    }

                } else {
                    const { sigs, block } = this.uBlock
                    if (Object.keys(sigs).length >= Math.floor(DEF.CONSENSUE_COUNT / 2 + 1)) {
                        //save block
                        console.log("cBlock hash:", block.hash)
                        this.indexers.db.saveBlock({ sigs, block })
                        this.uBlock = null
                        this.hasNewTX = false
                        continue
                    }
                }
                //broadcast current block or last block
                let bcBlock = this.uBlock
                if (!bcBlock) bcBlock = this.db.getBlock(this.height - 1, true)
                if (bcBlock) {
                    console.log("broadcast newBlock, height:", bcBlock.block.height, " hash:", bcBlock.block.hash, " sig:", objLen(bcBlock.sigs))
                    Nodes.notifyPeers({ cmd: "newBlock", data: bcBlock })
                }
            }
            //check other node
            //console.log(JSON.stringify(this.nodePool))
            for (const pkey in this.nodePool) {
                const node = this.nodePool[pkey]
                if (node.uBlock.block.height > this.height) { //download missing block
                    const n = this.db.getNode(pkey)
                    if (node && await this.downloadBlocks(this.height, node.uBlock.block.height, n.url)) {
                        this.uBlock = null
                        this.hasNewTX = false
                        break;
                    }
                }
            }
            await wait(DEF.BLOCK_TIME)
        }
    }
}
module.exports = BlockMgr