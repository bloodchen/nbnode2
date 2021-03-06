const config = require('./config').CONFIG
const axios = require('axios')
const coinfly = require('coinfly')
const rwc = require("random-weighted-choice")
var dns = require("dns");
const { NodeServer, NodeClient } = require('./nodeAPI');
const { DEF } = require('./def');
const CONSTS = require('./const')

//const Peer = require('peerjs-on-node')
let g_node = null
class Nodes {
    constructor() {
        this.pnodes = []
        this._canResolve = true
        this.nodeClients = {}
        //this.isProducer = config.server.producer
    }
    async sleep(seconds) {
        return new Promise(resolve => {
            setTimeout(resolve, seconds * 1000);
        })
    }

    get({ retUrl = true }) {
        const node = rwc(this.pnodes)
        return retUrl ? node : this.pnodes.find(item => item.id === node)
    }
    cool(url) {
        const node = this.pnodes.find(node => node.id == url)
        if (node) {
            node.weight--
        }
    }
    warm(url) {
        const node = this.pnodes.find(node => node.id == url)
        if (node) {
            node.weight++
        }
    }
    async init(indexers) {
        const lib = await coinfly.create('bsv')
        const pkey = await lib.getPublicKey(config.key)
        this.thisNode = { key: pkey }
        this._isProducer = this.isProducer(pkey)
        this.indexers = indexers
        this.nodeClient = new NodeClient()
        this.endpoint = config.server.publicUrl
        //if (!config.server.https) this.endpoint += ":" + config.server.port

        this.startNodeServer()
        await this.loadNodes(true)
        //await this.connectNodes()

        return true
    }
    startNodeServer() {
        if (!this.nodeServer) this.nodeServer = new NodeServer()
        this.nodeServer.start(this.indexers)
    }
    async _fromDNS() {
        return new Promise(resolve => {
            const domain = "nodes.nbdomain.com"
            dns.resolve(domain, "TXT", (err, data) => {
                let nodes = []
                for (let i = 0; i < data?.length; i++) {
                    const items = data[i][0].toLowerCase().split(',')
                    nodes = nodes.concat(items)
                }
                resolve(nodes)
            })
        })
    }
    async validatNode(url) {
        try {
            const res = await axios.get(url + "/api/nodeinfo")
            if (res.data && res.data.pkey) {
                return res.data
            }
        } catch (e) {
            console.error(url + ":" + e.message)
            return null
        }
    }
    incCorrect(key) {
        this.indexers.db.updateNodeScore(key, true)
    }
    incMistake(key) {
        this.indexers.db.updateNodeScore(key, false)
    }
    hasNode(url) {
        if (this.pnodes.find(item => item.id == url) || this.pnodes.find(item => item.id == url)) return true
        return false
    }
    async addNode({ url, isPublic = true }) {
        if (this.hasNode(url)) {
            return false
        }
        if (url.indexOf(this.endpoint) != -1) return false
        const info = await this.validatNode(url)
        if (!info) return false
        const node = { id: url, pkey: info.pkey, weight: 50 }
        this.pnodes.push(node)
        if (isPublic) {
            this.notifyPeers({ cmd: "newNode", data: { url } })
            this.indexers.db.addNode({ url, info })
            console.log("node added:", url)
            if (Object.keys(this.nodeClients).length < DEF.CONSENSUE_COUNT) {
                await this.connectOneNode(node)
            }
        }
        return true
    }
    async loadNodes() {
        const self = this;
        const _addFromArray = async function (nodes) {
            if (!Array.isArray(nodes)) return
            for (const node of nodes) {
                await self.addNode({ url: node.url ? node.url : node })
                if (self.pnodes.length >= DEF.CONSENSUE_COUNT) break;
            }
        }
        const nodes = this.indexers.db.loadNodes(true) //load from db
        await _addFromArray(nodes)
        if (Object.keys(this.nodeClients).length < DEF.CONSENSUE_COUNT) { //load from local config
            await _addFromArray(config.pnodes)
        }
        if (Object.keys(this.nodeClients).length < DEF.CONSENSUE_COUNT) { //load from DNS
            const p = await this._fromDNS()
            await _addFromArray(p)
        }
        //setTimeout(this.refreshPeers.bind(this), 60000)
    }
    isProducer(pkey) {
        if (!pkey) return this._isProducer
        return CONSTS.producers.indexOf(pkey) != -1
    }
    async connectOneNode(node) {
        if (this.nodeClients[node.id]) {
            //disconnect lastone
        }
        if (!this.isProducer(node.pkey)) {
            return false
        }
        const client = new NodeClient(this.indexers, config.server.publicUrl);
        if (await client.connect(node)) {
            console.log("connected to:", node.id)
            this.nodeClients[node.id] = client
            return true
        }
        console.error("failed to connect:", node.id)
        return false
    }
    /*    async fastestNode(nodes) {
            return new Promise(resolve => {
                for (const node of nodes) {
                    try {
                        axios.get(node.id + "/api/nodeInfo").then(res => {
                            if (res.data && res.data.pkey) {
                                resolve(node)
                                return
                            }
                        })
                    } catch (e) { console.error("fastestNode:", e.message) }
                }
            })
        }
        async connectNodes() {
            for (const node of this.pnodes) {
                if (await this.connectOneNode(node)) {
                }
            }
            if (!this.nodeClients || Object.keys(this.nodeClients).length == 0) {
                console.error("cannot connect to any node")
                return false
            }
            return true
        } */
    getNodes() {
        return this.pnodes
    }

    async notifyPeers({ cmd, data }) {
        if (this.nodeServer) {
            this.nodeServer.notify({ cmd, data })
        }
    }
    async sendNewTx(obj) {
        if (this.nodeClients && Object.keys(this.nodeClients).length > 0) {
            //return rpcHandler.handleNewTxFromApp({ indexers: this.indexers, obj })
            const ret = await this.nodeClients[Object.keys(this.nodeClients)[0]].sendNewTx(obj)
            if (ret && Object.keys(this.nodeClients).length > 1) { //one node return success, send through another node, make sure it's sent
                this.nodeClients[Object.keys(this.nodeClients)[1]].sendNewTx(obj)
            }
            return ret
        }
        console.error("No Other nodes connected, cannot send tx")
        return { code: 1, msg: "No Other nodes connected, cannot send tx" }
    }
    async getTx(txid, from) {
        try {
            if (from) {
                const res = await axios.get(`${from}/api/p2p/gettx?txid=${txid}`)
                if (res.data) {
                    if (res.data.code == 0) return res.data
                }
            }
        } catch (e) { console.error("getTx:", e.message) }
        for (const node of this.getNodes()) {
            if (node.id == from) continue
            const url = node.id + "/api/p2p/gettx?txid=" + txid
            try {
                const res = await axios.get(url)
                if (res.data) {
                    if (res.data.tx) return res.data
                }
            } catch (e) { console.error("getTx:", e.message) }
        }
        return null
    }

    async getData(hash, option = { string: true }) {
        if (hash == 'undefined') {
            console.log("found")
        }
        for (const node of this.getNodes(false)) {
            const url = node.id + "/api/p2p/getdata?hash=" + hash + "&string=" + option.string
            try {
                const res = await axios.get(url)
                if (res.data && res.data.code == 0) {
                    return res.data
                }
            } catch (e) {
                console.error("getData:err getting from:", url, e.code, e.message)
            }
        }
        return {}
    }
    canResolve() {
        return this._canResolve
    }
    async startTxSync(indexers) {
        this.indexers = indexers
    }
    async pullNewTxs(fullSync = false) {
        const { db } = this.indexers
        let latestTime = fullSync ? db.getLastFullSyncTime() : db.getLatestTxTime()
        for (const id in this.nodeClients) {
            await this.nodeClients[id].pullNewTxs({ from: latestTime })
        }
    }
    static inst() {
        if (g_node == null) {
            g_node = new Nodes()
        }
        return g_node
    }
}
module.exports.Nodes = Nodes.inst()