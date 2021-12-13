
const { Util, CMD_BASE } = require("./util.js");
const { CMD, DEF } = require("./def")
//const DomainTool = require('./domainTool')
let bsvdb = null;
class Parser_Domain {
    constructor(blockchain) {
        this.blockchain = blockchain
    }
    init(db) {
        this.db = db;
        bsvdb = db;
    }
    parse(rtx) {
        let ret = {
            code: -1, msg: ""
        }
        try {
            const handler = this.getAllCommands()[rtx.command]
            if (handler)
                rtx.output = handler.parseTX(rtx)
            if (!rtx.output) {
                ret.msg = `Not a valid output: ${rtx.txid}`;
                return ret;
            }
        } catch (err) {
            ret.msg = err.message;
            console.error(err);
            return ret;
        }
        if (rtx.output.err) {
            console.error("parse domain:", rtx.output.err)
        }
        ret.code = 0;
        ret.obj = rtx;
        return ret;
    }
    static getAllCommands() {
        return {
            [CMD.KEY]: CMD_KEYUSER, [CMD.USER]: CMD_KEYUSER, [CMD.NOP]: CMD_NOP, [CMD.REGISTER]: CMD_REGISTER,
            [CMD.BUY]: CMD_BUY, [CMD.SELL]: CMD_SELL, [CMD.ADMIN]: CMD_ADMIN, [CMD.TRANSFER]: CMD_TRANSER, [CMD.MAKE_PUBLIC]: CMD_MAKE_PUBLIC
        }
    }
}
class CMD_MAKE_PUBLIC {
    static parseTX(rtx) {
        let output = CMD_BASE.parseTX(rtx);
        return output;
    }
    static fillObj(nidObj, rtx) {
        try {
            if (nidObj.owner_key == null) return null
            if (nidObj.owner_key == rtx.publicKey) {
                nidObj.status = DEF.STATUS_PUBLIC
            }
        } catch (e) {

        }
        return nidObj
    }
}
class CMD_REGISTER {
    static parseTX(rtx) {
        let output = CMD_BASE.parseTX(rtx);
        try {
            // Suppose the output array has a fixed order.
            // output 0 - OP_RETURN.
            output.owner_key = rtx.out[0].s5;
            if(rtx.out[0].s6){
                var extra = JSON.parse(rtx.out[0].s6);
                output.payTx = extra["pay_txid"];
            }
            try{
                if (rtx.out[0].s7)output.agent = rtx.out[0].s7;
            }catch(e){}
        } catch (err) {
            console.error(rtx.txid)
            console.log(err)
            output.err = "Invalid format for RegisterOutput class."
            return output
        }

        if (output.owner_key == null || output.owner_key == "") {
            output.err = "Invalid format for RegisterOutput class1."
            return output
        }

        try {
            Util.getAddressFromPublicKey(output.owner_key);
        } catch (err) {
            output.err = "Invalid format for RegisterOutput class2."
        }
        let addr = Util.getAddressFromPublicKey(rtx.publicKey);
        let authorsities = Util.getAdmins(output.protocol, rtx.height);
        if (!authorsities.includes(addr)) {
            output.err = "Input address not in authorities.";
        }
        return output
    }
    static fillObj(nidObj, rtx) {
        try {
            if (nidObj.owner_key) {
                rtx.output.err = nidObj.domain + ": Already registered"
                return null
            }//can't register twice
            nidObj.nid = rtx.output.nid;
            nidObj.owner_key = rtx.output.owner_key;
            nidObj.owner = Util.getAddressFromPublicKey(nidObj.owner_key)
            nidObj.txid = rtx.txid;
            nidObj.status = DEF.STATUS_VALID;
            nidObj.domain = rtx.output.domain;
            nidObj.lastUpdateheight = rtx.height;
        } catch (e) {
            rtx.output.err = e.message
            return null //some data is invalid, probably owner_key is not a valid public key
        }
        return nidObj
    }
}
class CMD_BUY {
    static parseTX(rtx) {
        let output = CMD_BASE.parseTX(rtx);
        try {
            var extra = JSON.parse(rtx.out[0].s6);
            output.transferTx = extra["sell_txid"];
            output.payTxid = extra["pay_txid"];
            output.agent = rtx.out[0].s7;
            output.owner_key = rtx.out[0].s5;
        } catch (err) {
            output.err = "Invalid format for BuyOutput class."
            return output
        }
        let addr = Util.getAddressFromPublicKey(rtx.publicKey);
        let authorsities = Util.getAdmins(
            output.protocol,
            rtx.height
        );
        if (!authorsities.includes(addr)) {
            output.err = "Input address not in authorities.";
            return output
        }
        return output
    }
    static fillObj(nidObj, rtx) {
        if (nidObj.owner_key == null) return null
        if (nidObj.status == DEF.STATUS_TRANSFERING && nidObj.sell_info) {
            //TODO validate
            {
                if (rtx.time != -1 && rtx.time * 1000 > Number(nidObj.sell_info.expire)) return null //expired
                let clearData = nidObj.sell_info.clear_data;
                if (nidObj.sell_info.buyer != 'any') { //check if it's the right buyer
                    if (Util.getAddressFromPublicKey(rtx.output.owner_key) != nidObj.sell_info.buyer)
                        return null
                }
                nidObj = Util.resetNid(nidObj, rtx.output.owner_key, rtx.txid, DEF.STATUS_VALID, clearData);
            }
        }
        return nidObj
    }
}
class CMD_SELL {
    static parseTX(rtx) {
        let output = CMD_BASE.parseTX(rtx);
        try {
            var extra = JSON.parse(rtx.out[0].s5);
            output.buyer = extra["buyer"];
            output.note = extra["note"];
            output.price = Number(extra["price"]);
            output.expire = Number(extra["expire"]);
            output.clear_data = extra["clear_data"];
        } catch (err) {
            output.err = "Invalid format for SellOutput class."
        }
        return output
    }
    static fillObj(nidObj, rtx) {
        if (nidObj.owner_key == null) return null
        if (nidObj.owner_key == rtx.publicKey && nidObj.status != DEF.STATUS_PUBLIC) { //cannot sell public domain
            nidObj.status = DEF.STATUS_TRANSFERING
            //nidObj = DomainTool.updateNidObjFromRX(nidObj, rtx);
            nidObj.sell_info = {
                price: rtx.output.price,
                buyer: rtx.output.buyer,
                expire: rtx.output.expire,
                note: rtx.output.note,
                clear_data: rtx.output.clear_data,
                seller: Util.getAddressFromPublicKey(rtx.publicKey).toString(),
                sell_txid: rtx.txid
            };
            nidObj.tf_update_tx = rtx.txid;
        }
        return nidObj
    }
}
class CMD_NOP {
    static parseTX(rtx) {
        let output = CMD_BASE.parseTX(rtx);
        return output
    }
    static fillObj(nidObj, rtx) {
        if (nidObj.owner_key == null) return null
        return nidObj
    }
}
class CMD_TRANSER {
    static parseTX(rtx) {
        let output = CMD_BASE.parseTX(rtx);
        try {
            output.owner_key = rtx.out[0].s5.toLowerCase();
            output.transfer_fee = rtx.out[3].e.v;
            output.payment_addr = rtx.out[3].e.a;
            Util.getAddressFromPublicKey(output.owner_key) //test public key
        } catch (err) {
            output.err = "Invalid format for Transfer command."
            return output
        }
        if (output.transfer_fee < 1000) {
            output.err = "Transfer command must pay admin fee 1000 satoshi."
            return output
        }

        let adminAddr = Util.getTLDFromRegisterProtocol(output.protocol)[1];
        if (output.payment_addr != adminAddr) {
            output.err = "Payment failed, admin address is incorrect."
        }
        return output
    }
    static fillObj(nidObj, rtx) {
        if (nidObj.owner_key == null) return null
        try {
            if (nidObj.owner_key == rtx.publicKey && nidObj.status != DEF.STATUS_PUBLIC) { //can not transfer public domain
                //nidObj = DomainTool.updateNidObjFromRX(nidObj, rtx)
                nidObj.owner_key = rtx.output.owner_key;
                nidObj.owner = Util.getAddressFromPublicKey(rtx.output.owner_key).toString();
            }
        } catch (e) {
            console.error("fillObj: Transfer command invalid")
            return null
        }
        return nidObj
    }
}
class CMD_ADMIN {
    static parseTX(rtx) {
        let output = CMD_BASE.parseTX(rtx);
        try {
            var extra = JSON.parse(rtx.out[0].s5);
            output.key = Object.keys(extra)[0];
            output.value = extra[output.key];
        } catch (err) {
            output.err = "Invalid format for MetaDataOutput class."
        }
        return output
    }
    static fillObj(nidObj, rtx) {
        if (nidObj.owner_key == null) return null
        if (nidObj.owner_key == rtx.publicKey)
            //nidObj = DomainTool.updateNidObjFromRX(nidObj, rtx);
            nidObj.admins = rtx.output.value;
        nidObj.admin_update_tx = rtx.txid;
        return nidObj
    }
}
class CMD_KEYUSER {
    static parseTX(rtx) {
        let output = CMD_BASE.parseTX(rtx);
        try {
            let tags = null, pay = {}, hasPay = false
            output.value = JSON.parse(rtx.out[0].s5);
            try {
                tags = JSON.parse(rtx.out[0].s6).tags;
                if (tags)
                rtx.command == "key"
                        ? (output.tags = tags)
                        : (output.utags = tags);
            } catch (e) { }

            for (const out of rtx.out) {
                if (out.e.a && out.e.a != rtx.inputAddress) {
                    pay[out.e.a] = out.e.v
                    hasPay = true
                }
            }

            if (hasPay)
                output.pay = pay
        } catch (e) {
            output.err = e.message
        }
        if (typeof output.value != "object") {
            output.err = "Invalid key transaction record. Record must be object!"
        }
        return output;
    }
    static updateKeyAndHistory(obj, txid, key, value, ts, tags, pay) {
        if (key == "todomain") return false//'todomain' is not a key
        const oldvalue = obj.keys[key];
        if (oldvalue) {
            bsvdb.saveKeyHistory(obj, key, oldvalue);
        }
        obj.keys[key] = { value: value, txid: txid };
        if (ts) {
            obj.keys[key].ts = ts;
        }
        if (pay)
            obj.keys[key].pay = pay;
        if (tags) {
            obj.tag_map[key + '.'] = tags;
        }
        return true
    }
    static fillObj(nidObj, rtx, objMap) {
        if (nidObj.owner_key == null) {
            rtx.output.err = "No owner"
            return null
        }
        if (nidObj.owner_key != rtx.publicKey) { //different owner
            let authorized = false; //check admin
            rtx.output.err = "unAuthorized owner"
            for (var name in nidObj.admins) {
                var adminAddress = nidObj.admins[name];
                if (adminAddress == Util.getAddressFromPublicKey(rtx.publicKey)) {
                    authorized = true;
                    rtx.output.err = null;
                }
            }
            if (!authorized)
                return null;
        }
        const ts = rtx.time ? rtx.time : new Date().valueOf()
        if (rtx.command == CMD.KEY) {
            if (rtx.output.value.toDomain) {
                let obj = objMap[rtx.output.value.toDomain]
                if (!obj) {
                    obj = bsvdb.loadDomain(rtx.output.value.toDomain)
                    objMap[rtx.output.value.toDomain] = obj
                }
                if (obj && obj.status == DEF.STATUS_PUBLIC) {

                    for (const key in rtx.output.value) {
                        let lowerKey = key.toLowerCase()
                        if (CMD_KEYUSER.updateKeyAndHistory(obj, rtx.txid, lowerKey, rtx.output.value[key], ts, rtx.output.tags, rtx.output.pay))
                            obj.keys[lowerKey].fromDomain = nidObj.domain
                    }
                    obj.dirty = true
                }
            } else {
                for (const key in rtx.output.value) {
                    let lowerKey = key.toLowerCase();
                    CMD_KEYUSER.updateKeyAndHistory(nidObj, rtx.txid, lowerKey, rtx.output.value[key], ts, rtx.output.tags, rtx.output.pay)
                }
            }

        }
        if (rtx.command == CMD.USER) {
            // Change deep merge to shallow merge.
            for (const key in rtx.output.value) {
                let lowerKey = key.toLowerCase();
                nidObj.users[lowerKey] = { value: rtx.output.value[key], txid: rtx.txid, ts: ts };
                nidObj.update_tx[lowerKey + '@'] = rtx.txid;
                if (rtx.output.tags) {
                    nidObj.tag_map[lowerKey + '@'] = rtx.output.tags;
                }
            }
        }
        return nidObj
    }
}

module.exports = { Parser_Domain }