/* jshint esversion: 6 */ 

/**
 * TODO:
 * - @ everyone in list when modbreak is performed
 **/

const SittardGoBot = require('./SittardGoBot');
const MessageTests = require('./MessageTests');
const RaidLists    = require('./RaidLists');
const RaidStats    = require('./RaidStats');

const CLIENT_ID  = '0';
const TOKEN      = '0';

const TEST_CLIENT_ID = '0';
const TEST_TOKEN     = '0';
const TEST_CHANNEL   = '0';
const TEST_GUILD     = '0';

const VERSION = '1.5';
const DESCRIPTION = 'A Discord bot to automate raid joining';

const DEV_MODE = false;

const MESSAGES = {
    missing_raid_id       : 'Raid nummer missend',
    invalid_raid_id       : 'Raid {ID} is niet actief',
    invalid_canceled_raid : 'Raid **{ID}** was gecanceld',
    mod_operation         : 'Alleen @Moderators kunnen raids aanpassen',
    raid_emition_fail     : 'Er is iets mis gegaan contacteer een Administrator',
    auto_join_msg         : '`(auto-join met +{ID})`',
    raid_cancelled        : 'Raid nr. **{ID}** gecanceld',
};

const ADD_TEAM_ICONS = true;
const REMOVE_COMMAND = false;
const RESET_CHECK_INTERVAL = 60*60*1000;

class raidJoinBot {

    constructor() {
        this.raidLists = new RaidLists();
        
        if (DEV_MODE) {
            this.bot = new SittardGoBot.Bot(
                TEST_TOKEN, TEST_CLIENT_ID, DESCRIPTION, VERSION
            );
        } else {
            this.bot = new SittardGoBot.Bot(
                TOKEN, CLIENT_ID, DESCRIPTION, VERSION
            );
        }
            
        this.bot.on('MESSAGE', this.receiveMessage.bind(this));

        // Pulse to check for a raid lists reset
        setInterval(_ => {
            const hasReset = this.raidLists.reset();
            
            if (!hasReset) {
                return;
            }
            
            RaidStats.writeLog(this.raidLists.prevLists);
            RaidStats.emitDailyStats(this.bot, 'raid');

            if (RaidStats.isLastDayOfMonth()) {
                RaidStats.emitMonthlyStats(this.bot, 'raid');
            }

        }, RESET_CHECK_INTERVAL);

        this.bot.connect()
            .then(_ => {
                // for test invoking
            })
            .catch(e => console.log('error', e));
    }

    receiveMessage(e, msgObj) {
        const msgTxt = msgObj.content.trim();

        if (!MessageTests.is('command', msgTxt)) {
            return;
        }

        // New List
        if (MessageTests.is('startraid', msgTxt)) {
            this.createRaid(msgObj, msgTxt);
            return;
        }

        const raidId = MessageTests.extractId(msgTxt);

        // This should never happen (regex checks for numbers)
        if (!raidId) {
            this.bot.reply(msgObj, MESSAGES.missing_raid_id);
            return;
        }

        // Return a message if id isn't valid
        const searchRes = this.raidLists.isValidId(raidId);
        if (searchRes.valid === false) {
            return this.emitInvalid(searchRes, msgObj, raidId);
        }

        // Modbreak
        if (MessageTests.is('modbreak', msgTxt)) {
            this.doModBreak(msgObj, raidId, msgTxt);
            return;
        }

        // Cancel raid
        if (MessageTests.is('cancelraid', msgTxt)) {
            this.cancelRaid(msgObj, raidId);
            return;
        }

        // Join raid
        if (MessageTests.is('joinraid', msgTxt)) {
            this.joinRaid(msgObj, raidId);
            return;
        }

        // Leave raid
        if (MessageTests.is('leaveraid', msgTxt)) {
            const resLeave = this.raidLists.leave(
                raidId, msgObj.author.id
            );
            
            if (resLeave) {
                this.emitRaid(msgObj, raidId);
            }
            return;
        }
    }

    createRaid(msgObj, msgTxt) {
        const raidOP = MessageTests.stripCommand('startraid', msgTxt);
        let raidOG = this.bot.getMessageUsername(msgObj);
        
        const newId = this.raidLists.create(raidOP.trim(), msgObj.author.id);

        if (newId > 2 && DEV_MODE) {
            this.raidLists.writeDailyLog();
        }

        console.log(`raid started by ${raidOG}: ${raidOP} (id: ${newId})`);

        this.joinRaid(msgObj, newId, msgObj.author.id);
    }

    cancelRaid(msgObj, raidId) {
        const res = this.raidLists.cancel(raidId, msgObj.author.id);
        if (!res) {
            return;
        }

        console.log(
            `Raid ${raidId} canceled by: `+
            this.bot.getMessageUsername(msgObj)
        );

        const raid = this.raidLists.get(raidId);

        const op = this.raidLists
            .getOP(raidId)
            .replace(/\`\(auto.+\)\`\s*/, '')
            .trim();

        let reply = MESSAGES.raid_cancelled
            .replace('{ID}', raidId) +
            ` (${op})\n`;
        
        const notified = [];
        
        raid.users.map(u => {
            if (notified.indexOf(u.userId) > -1) {
                return;
            }

            notified.push(u.userId);
            reply += this.bot.getGuild().members.get(u.userId).toString()+' ';
        });

        this.bot.reply(msgObj, reply);
    }

    joinRaid(msgObj, raidId) {
        const username = this.bot.getMessageUsername(msgObj);
        const msgTxt = msgObj.content.trim();
        let team = false;

        if (MessageTests.is('withTeamHint', msgTxt)) {
            switch(msgTxt.split('').pop().toLowerCase()) {
                case 'v': team = 'valor'; break;
                case 'i': team = 'instinct'; break;
                case 'm': team = 'mystic'; break;
            }
        } else {
            team = this.bot.getTeamOfMember(msgObj.member);
        }

        this.raidLists.join(raidId, msgObj.author.id, username, team);
        
        this.emitRaid(msgObj, raidId);
    }

    doModBreak(msgObj, raidId, msgTxt) {
        const modTxt = MessageTests
            .stripCommand('modbreak', msgTxt)
            .replace(/(\(auto.+\))/g, '')
            .trim();

        this.raidLists.override(raidId, modTxt);

        this.emitRaid(msgObj, raidId);
    }

    emitRaid(msgObj, raidId) {
        const raid = this.raidLists.get(raidId);

        if (!raid) {
            this.bot.reply(msgObj, MESSAGES.raid_emition_fail);
            return;
        }

        let r = 0,
            txt = raid.op;

        txt += `\n${MESSAGES.auto_join_msg}\n`.replace('{ID}', raidId);

        raid.users.map(u => {
            r++;
            const icon = (ADD_TEAM_ICONS)? this.bot.getTeamIcon(u.team) : ' ';
            const index = (String(r).length < 2)? r+' ' : r;
            txt += `\n\`${index}| \` ${icon} ${u.username}`;
        });

        if (REMOVE_COMMAND) {
            msgObj.delete().catch(console.error);
        }

        this.bot.reply(msgObj, txt)
            .catch(_ => console.log('error', _));
    }

    emitInvalid(searchRes, msgObj, raidId) {
        const msg = (searchRes.reason === 'canceled') ?
            MESSAGES.invalid_canceled_raid: 
            MESSAGES.invalid_raid_id;

        this.bot.reply(msgObj, msg.replace('{ID}', raidId));
    }
}

new raidJoinBot();