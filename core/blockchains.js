const TXO = require("./txo.js");
const { DEF } = require("./def");
const BitID = require('bitidentity');
class ARChain {
    static verify(rawtx, height) {
        const publicKey = rawtx.owner.key
        if (!publicKey) {
            return { code: -1, msg: `Failed to verify transaction signature.` }
        }
        const rtx = ARChain.raw2rtx(rawtx)
        return { code: 0,txTime:rtx.ts }
    }
    static raw2rtx(rawtx) {
        const tx = JSON.parse(rawtx);
        let rtx = {
            height: tx.block.height,
            ts: +(tx.tags.txTime),
            txid: tx.id,
            publicKey: tx.owner.key,
            command: tx.tags.command,
            output: null,
            tx: tx
        };
        rtx.blockchain = 'ar'
        return rtx
    }
}
class BSVChain {
    static verifySig(rawtx) { //retuen publicKey or null
        let rtxVerified = BitID.verifyID(rawtx)
        if (!rtxVerified) {
            return null
        }
        let keyArray = BitID.getBitID(rawtx)
        if (keyArray.length > 0) {
            return keyArray[0].publicKey.toString()
        }
        return null
    }
    static verify(rawtx, height,block_time) {
        let txTime = null
        if (!height || height == -1 || height > DEF.BLOCK_SIGNATURE_UPDATE) {
            const publicKey = BSVChain.verifySig(rawtx)
            if (!publicKey) {
                return { code: -1, msg: `Failed to verify transaction signature.` }
            }
        }
        if(block_time){ //check txtime
            const rtx = BSVChain.raw2rtx(rawtx)
            txTime = rtx.ts
            if(rtx.ts&&rtx.ts>block_time)
                return { code: -1, msg: 'txTime invalid' }
        }
        return { code: 0,txTime:txTime }
    }
    static _reArrage(rtx) {
        if (rtx.out[0].s2 === "nbd") {
            for (let i = 2; i < rtx.out[0].len; i++) {
                rtx.out[0]["s" + (i + 2)]
                    ? (rtx.out[0]["s" + i] = rtx.out[0]["s" + (i + 2)])
                    : "";
                rtx.out[0]["b" + (i + 2)]
                    ? (rtx.out[0]["b" + i] = rtx.out[0]["b" + (i + 2)])
                    : "";
                rtx.out[0]["h" + (i + 2)]
                    ? (rtx.out[0]["h" + i] = rtx.out[0]["h" + (i + 2)])
                    : "";
                rtx.out[0]["f" + (i + 2)]
                    ? (rtx.out[0]["f" + i] = rtx.out[0]["f" + (i + 2)])
                    : "";
            }
        }
    }
    static raw2rtx(rawtx,height) {
        const tx = TXO.fromRaw(rawtx);
        let rtx = {
            height: height,
            //ts: timestamp,
            txid: tx.tx.h,
            publicKey: tx.in[0].h1.toString(),
            command: tx.out[0].s2 == "nbd" ? tx.out[0].s6 : tx.out[0].s4,
            // inputAddress: tx.in[0].e.a.toString(),
            output: null,
            in: tx.in,
            out: tx.out,
        };
        if(tx.out[0].s2 == "nbd"&&tx.out[0].s3 != "1"){
            try{
                const attrib = JSON.parse(tx.out[0].s3)
                rtx.ts = +attrib.ts
            }catch(e){}
            
        }
        tx.in.forEach(inp=>{if(inp.e.a)rtx.inputAddress = inp.e.a.toString()})
        BSVChain._reArrage(rtx)
        rtx.blockchain = 'bsv'
        return rtx
    }
}

module.exports = {
    ARChain, BSVChain
}