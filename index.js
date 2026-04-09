const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let rtpBandar = { roulette: 40, coinflip: 40, spinwheel: 30, spaceman: 30, baccarat: 40, slot: 35 };
let forceSpacemanMulti = null; 
let targetedJP = {}; 

const dbPath = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'lgolux.db') : './lgolux.db';
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'member', coin INTEGER DEFAULT 0, status TEXT DEFAULT 'AKTIF')`);
    db.run(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, type TEXT, amount INTEGER, status TEXT DEFAULT 'PENDING', note TEXT, date DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`ALTER TABLE transactions ADD COLUMN note TEXT`, (err) => {}); 
    bcrypt.hash('admin123', 10, (err, hash) => { 
        db.run(`INSERT OR IGNORE INTO users (username, password, role, coin) VALUES ('admin', ?, 'admin', 9999999)`, [hash]); 
    });
});

const sessionMiddleware = session({ secret: 'lgolux-rahasia-jp', resave: false, saveUninitialized: true });
app.use(express.json()); 
app.use(sessionMiddleware); 
app.use(express.static(path.join(__dirname, 'public'))); 
io.engine.use(sessionMiddleware);

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/spaceman', (req, res) => res.sendFile(path.join(__dirname, 'public', 'spaceman.html')));
app.get('/roulette', (req, res) => res.sendFile(path.join(__dirname, 'public', 'roulette.html')));
app.get('/coinflip', (req, res) => res.sendFile(path.join(__dirname, 'public', 'coinflip.html')));
app.get('/spinwheel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'spinwheel.html')));
app.get('/baccarat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'baccarat.html')));
app.get('/sweet', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sweet.html')));
app.get('/zeus', (req, res) => res.sendFile(path.join(__dirname, 'public', 'zeus.html')));
app.get('/princess', (req, res) => res.sendFile(path.join(__dirname, 'public', 'princess.html')));

app.post('/api/register', (req, res) => { 
    const { username, password, role } = req.body; 
    if (!username || !password) return res.json({ success: false, msg: '⚠️ Username dan Password wajib diisi!' }); 
    const userRole = (role === 'admin' && req.session.role === 'admin') ? 'admin' : 'member'; 
    bcrypt.hash(password, 10, (err, hash) => { 
        db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, [username.toLowerCase(), hash, userRole], function(err) { 
            if (err) return res.json({ success: false, msg: '❌ Username sudah dipakai!' }); 
            res.json({ success: true, msg: '✅ Akun berhasil dibuat!' }); 
        }); 
    }); 
});

app.post('/api/login', (req, res) => { 
    const { username, password } = req.body; 
    if (!username || !password) return res.json({ success: false, msg: '⚠️ Wajib diisi!' }); 
    db.get(`SELECT * FROM users WHERE username = ?`, [username.toLowerCase()], (err, user) => { 
        if (!user) return res.json({ success: false, msg: '❌ User tidak ditemukan!' }); 
        if (user.status === 'BLOKIR') return res.json({ success: false, msg: '🚫 DIBLOKIR!' }); 
        bcrypt.compare(password, user.password, (err, match) => { 
            if (!match) return res.json({ success: false, msg: '❌ Password salah!' }); 
            req.session.userId = user.id; req.session.username = user.username; req.session.role = user.role; 
            res.json({ success: true, role: user.role }); 
        }); 
    }); 
});

app.get('/api/me', (req, res) => { 
    if (!req.session.userId) return res.json({ loggedIn: false }); 
    db.get(`SELECT id, username, role, coin, status FROM users WHERE id = ?`, [req.session.userId], (err, user) => { 
        if (user) res.json({ loggedIn: true, ...user }); else res.json({ loggedIn: false }); 
    }); 
});

app.get('/api/history', (req, res) => { 
    if (!req.session.userId) return res.json([]); 
    db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC LIMIT 15`, [req.session.userId], (err, rows) => res.json(rows || [])); 
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// API ADMIN
app.get('/api/admin/users', (req, res) => { 
    if (req.session.role !== 'admin') return res.status(403).send(); 
    db.all(`SELECT id, username, coin, status FROM users WHERE role = 'member' ORDER BY id DESC`, (err, rows) => res.json(rows)); 
});

app.post('/api/admin/update-user', (req, res) => { 
    if (req.session.role !== 'admin') return res.status(403).send(); 
    const { id, coin, status, password, note, username } = req.body; 
    db.get(`SELECT coin FROM users WHERE id = ?`, [id], (err, user) => { 
        if(!user) return res.json({success: false}); 
        const diff = coin - user.coin; 
        if (diff !== 0) { 
            const adjType = diff > 0 ? 'BONUS ADMIN' : 'POTONGAN ADMIN'; 
            db.run(`INSERT INTO transactions (user_id, username, type, amount, status, note) VALUES (?, ?, ?, ?, 'SUCCESS', ?)`, [id, username, adjType, Math.abs(diff), note]); 
        } 
        if (password && password.trim() !== "") { 
            bcrypt.hash(password, 10, (err, hash) => db.run(`UPDATE users SET password = ?, coin = ?, status = ? WHERE id = ?`, [hash, coin, status, id])); 
        } else { 
            db.run(`UPDATE users SET coin = ?, status = ? WHERE id = ?`, [coin, status, id]); 
        } 
        res.json({ success: true }); 
    }); 
});

io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.userId) return;

    socket.join(`user_${session.userId}`);
    if (session.role === 'admin') socket.join('admins');

    socket.on('get_rtp', () => { 
        if (session.role === 'admin') socket.emit('rtp_data', { ...rtpBandar, astronaut: rtpBandar.spaceman, slot: rtpBandar.slot }); 
    });

    socket.on('update_rtp', (newRtp) => { 
        if (session.role === 'admin') { 
            rtpBandar.roulette = newRtp.roulette; rtpBandar.coinflip = newRtp.coinflip; rtpBandar.spinwheel = newRtp.spinwheel; rtpBandar.spaceman = newRtp.astronaut || newRtp.spaceman || 30; rtpBandar.slot = newRtp.slot || 35; 
            io.to('admins').emit('rtp_data', { ...rtpBandar, astronaut: rtpBandar.spaceman, slot: rtpBandar.slot }); 
            socket.emit('notif_msg', '😈 Win Rate Normal Diperbarui!'); 
        } 
    });

    socket.on('force_astro', (val) => { 
        if (session.role === 'admin') { 
            forceSpacemanMulti = parseFloat(val); 
            socket.emit('notif_msg', `🚀 SUPER JP AKTIF: Spaceman berikutnya PASTI x${forceSpacemanMulti}!`); 
        } 
    });
    
    socket.on('set_target_jp', (data) => { 
        if (session.role === 'admin') { 
            let targetUser = data.username.toLowerCase().trim();
            targetedJP[targetUser] = { gameId: data.gameId, type: data.type, multi: parseFloat(data.multi), targetWin: parseInt(data.targetWin) }; 
            socket.emit('notif_msg', `🎯 PANEL DEWA AKTIF: Target JP dipasang untuk ${targetUser.toUpperCase()} di game ${data.gameId.toUpperCase()}!`); 
        } 
    });

    // KASTA SIMBOL (Hanya ditulis 1 kali di sini)
    const slotSymbols = {
        'zeus': [ { s:'👑', max:4.0 }, { s:'⏳', max:2.5 }, { s:'💍', max:1.5 }, { s:'🛡️', max:1.0 }, { s:'💎', max:0.5 } ],
        'sweet': [ { s:'🍭', max:4.0 }, { s:'🍬', max:2.5 }, { s:'🍇', max:1.5 }, { s:'🍉', max:1.0 }, { s:'🍌', max:0.5 } ],
        'princess': [ { s:'👑', max:4.0 }, { s:'⭐', max:2.5 }, { s:'❤️', max:1.5 }, { s:'☀️', max:1.0 }, { s:'🌙', max:0.5 } ]
    };

    // --- GAME SLOT V3 ---
    socket.on('play_video_slot', (data) => {
        const { betAmount, spinType, gameId } = data; 
        
        if (betAmount > 1000000) return socket.emit('game_result', { game: 'slot', status: 'error', msg: '❌ Max Bet 1 Juta bosku!' });
        if (spinType === 'manual' && betAmount < 400) return socket.emit('game_result', { game: 'slot', status: 'error', msg: '❌ Spin Manual Minimal 400 Perak!' });
        if (spinType !== 'manual' && betAmount < 200) return socket.emit('game_result', { game: 'slot', status: 'error', msg: '❌ Buy Spin Minimal Bet Dasar 200 Perak!' });

        let totalCost = betAmount;
        if (spinType === 'buy') totalCost = betAmount * 100;
        if (spinType === 'super') totalCost = betAmount * 500;
        
        db.get(`SELECT coin, status FROM users WHERE id = ?`, [session.userId], (err, user) => {
            if (user.status === 'BLOKIR') return;
            if (user.coin < totalCost) return socket.emit('game_result', { game: 'slot', status: 'error', msg: '❌ Saldo tidak cukup bosku!' });
            
            db.run(`UPDATE users SET coin = coin - ? WHERE id = ?`, [totalCost, session.userId], () => {
                socket.emit('update_coin', user.coin - totalCost);
                
                let uname = session.username.toLowerCase();
                let isTargeted = targetedJP[uname] && targetedJP[uname].gameId === gameId;
                let tData = isTargeted ? targetedJP[uname] : null;
                
                let triggerFreespin = (spinType !== 'manual') ? true : (Math.random() < 0.01);
                
                if (triggerFreespin || isTargeted) {
                    let spinsData = [];
                    let totalWin = 0;
                    let globalMulti = 0; 
                    let maxwinCap = (gameId === 'sweet') ? 25000 : 15000;
                    let targetFinalWin = isTargeted ? ((tData.type === 'maxwin') ? (betAmount * maxwinCap) : tData.targetWin) : 0;
                    let sisaTarget = targetFinalWin;

                    for(let i = 0; i < 15; i++) {
                        let spinWin = 0; let dropMulti = 0; let winSymbol = null;
                        let symList = slotSymbols[gameId];
                        let picked = symList[Math.floor(Math.random() * symList.length)];
                        winSymbol = picked.s;

                        if (isTargeted) {
                            if ([3, 7, 10, 14].includes(i) || (i === 14 && sisaTarget > 0)) {
                                let portion = (i === 14) ? sisaTarget : Math.floor(sisaTarget * (Math.random() * 0.3 + 0.1));
                                
                                dropMulti = (tData.type === 'maxwin') ? [100, 250, 500, 1000][Math.floor(Math.random()*4)] : tData.multi;
                                if (gameId !== 'sweet') globalMulti += dropMulti;
                                
                                let effectiveMulti = (gameId === 'sweet') ? dropMulti : (globalMulti > 0 ? globalMulti : 1);
                                spinWin = Math.floor(portion / (effectiveMulti > 0 ? effectiveMulti : 1));
                                
                                sisaTarget -= (spinWin * effectiveMulti);
                            } else {
                                spinWin = 0; dropMulti = 0;
                            }
                        } else {
                            let isWinSpin = Math.random() < (rtpBandar.slot / 100);
                            if (isWinSpin) spinWin = Math.floor(betAmount * (Math.random() * (picked.max - (picked.max/2)) + (picked.max/2)));
                            
                            if (isWinSpin && Math.random() < 0.35) {
                                let multiList = [2, 5, 10, 15, 20, 25, 50, 100, 250, 500];
                                if (gameId === 'sweet') multiList.push(1000); 
                                dropMulti = multiList[Math.floor(Math.random() * multiList.length)];
                                if (spinType === 'super' && Math.random() < 0.3) dropMulti = (Math.random() < 0.5) ? 500 : 1000; 
                            }
                        }

                        let numTumbles = spinWin > 0 ? Math.floor(Math.random() * 3) + 1 : 0;
                        spinsData.push({ win: spinWin, multi: dropMulti, symbol: winSymbol, tumbles: numTumbles });
                        
                        if (gameId === 'sweet') { totalWin += spinWin * (dropMulti > 0 ? dropMulti : 1); } 
                        else {
                            if (dropMulti > 0 && spinWin > 0) globalMulti += dropMulti; 
                            totalWin += spinWin * (globalMulti > 0 ? globalMulti : 1);
                        }
                    }

                    if (totalWin > betAmount * maxwinCap) totalWin = betAmount * maxwinCap;
                    if (isTargeted) delete targetedJP[uname];

                    db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [totalWin, session.userId], () => {
                        db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, u) => {
                            let isMurni = spinType === 'manual';
                            socket.emit('slot_freespin_start', { spins: spinsData, finalWin: totalWin, finalCoin: u.coin, isMurni });
                        });
                    });

                } else {
                    const isWin = Math.random() < (rtpBandar.slot / 100);
                    let normalWin = 0; let winSymbol = null; let numTumbles = 0;
                    
                    if (isWin) {
                        let symList = slotSymbols[gameId];
                        let picked = symList[Math.floor(Math.random() * symList.length)];
                        winSymbol = picked.s;
                        normalWin = Math.floor(betAmount * (Math.random() * (picked.max - (picked.max/2)) + (picked.max/2)));
                        numTumbles = Math.floor(Math.random() * 3) + 1; 
                    }

                    let dropMulti = 0;
                    if (isWin && (gameId === 'zeus' || gameId === 'princess') && Math.random() < 0.15) {
                        const multiList = [2, 5, 10, 15, 20, 25, 50, 100, 250, 500];
                        dropMulti = multiList[Math.floor(Math.random() * multiList.length)];
                        normalWin = normalWin * dropMulti; 
                    }
                    
                    if (normalWin > 0) {
                        db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [normalWin, session.userId], () => {
                            db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, u) => {
                                io.to(`user_${session.userId}`).emit('update_coin', u.coin);
                                socket.emit('slot_normal_result', { status: 'win', winAmount: normalWin, multi: dropMulti, symbol: winSymbol, tumbles: numTumbles });
                            });
                        });
                    } else {
                        socket.emit('slot_normal_result', { status: 'lose', winAmount: 0, multi: 0, symbol: null, tumbles: 0 });
                    }
                }
            });
        });
    });

    socket.on('req_deposit', (a) => { db.run(`INSERT INTO transactions (user_id, username, type, amount, status) VALUES (?, ?, 'DEPOSIT', ?, 'PENDING')`, [session.userId, session.username, a], () => { io.to('admins').emit('admin_new_notif'); socket.emit('notif_msg', `✅ Request terkirim!`); }); });
    socket.on('req_wd', (a) => { db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, u) => { if (!u || u.coin < a) return socket.emit('notif_msg', '❌ Saldo tidak cukup!'); db.run(`UPDATE users SET coin = coin - ? WHERE id = ?`, [a, session.userId], () => { db.run(`INSERT INTO transactions (user_id, username, type, amount, status) VALUES (?, ?, 'WD', ?, 'PENDING')`, [session.userId, session.username, a]); io.to(`user_${session.userId}`).emit('update_coin', u.coin - a); io.to('admins').emit('admin_new_notif'); socket.emit('notif_msg', '💸 WD Diproses!'); }); }); });
    socket.on('admin_approve_tx', (id) => { if(session.role!=='admin') return; db.get(`SELECT * FROM transactions WHERE id=? AND status='PENDING'`,[id], (err,tx)=>{ if(!tx)return; db.run(`UPDATE transactions SET status='SUCCESS' WHERE id=?`,[id]); if(tx.type==='DEPOSIT'){ db.run(`UPDATE users SET coin=coin+? WHERE id=?`,[tx.amount, tx.user_id],()=>{ db.get(`SELECT coin FROM users WHERE id=?`,[tx.user_id],(err,u)=>io.to(`user_${tx.user_id}`).emit('update_coin',u.coin)); }); } socket.emit('deposit_approved_success'); }); });
    socket.on('admin_reject_tx', (data) => { if(session.role!=='admin') return; db.get(`SELECT * FROM transactions WHERE id=? AND status='PENDING'`,[data.id], (err,tx)=>{ if(!tx)return; db.run(`UPDATE transactions SET status='REJECTED', note=? WHERE id=?`,[data.reason, data.id]); if(tx.type==='WD'){ db.run(`UPDATE users SET coin=coin+? WHERE id=?`,[tx.amount, tx.user_id],()=>{ db.get(`SELECT coin FROM users WHERE id=?`,[tx.user_id],(err,u)=>io.to(`user_${tx.user_id}`).emit('update_coin',u.coin)); }); } socket.emit('deposit_approved_success'); }); });
    socket.on('get_pending_deposits', () => { if(session.role==='admin') db.all(`SELECT * FROM transactions WHERE status='PENDING' ORDER BY date DESC`, (err, rows)=>socket.emit('admin_deposit_list', rows)); });
    
    // GAME LAMA (TETAP SAMA SEPERTI SEBELUMNYA)
    socket.on('play_spaceman', (data) => {
        const { betAmount } = data;
        if (betAmount > 1000000) return;
        db.get(`SELECT coin, status FROM users WHERE id = ?`, [session.userId], (err, user) => {
            if (user.status === 'BLOKIR' || user.coin < betAmount) return socket.emit('game_result', { game: 'spaceman', status: 'error', msg: '❌ Saldo tidak cukup bosku!' });
            db.run(`UPDATE users SET coin = coin - ? WHERE id = ?`, [betAmount, session.userId], () => {
                socket.emit('update_coin', user.coin - betAmount);
                let crashPoint = 1.00; 
                if (forceSpacemanMulti !== null) { crashPoint = forceSpacemanMulti; forceSpacemanMulti = null; } 
                else {
                    const isWin = Math.random() < (rtpBandar.spaceman / 100);
                    if (isWin) {
                        crashPoint = 1.00 + (Math.random() * 5); 
                        if(Math.random() < 0.2) crashPoint += Math.random() * 10; 
                        if(Math.random() < 0.05) crashPoint += Math.random() * 50; 
                        if(Math.random() < 0.01) crashPoint += Math.random() * 500; 
                    } else { crashPoint = 1.00 + (Math.random() * 0.4); }
                }
                crashPoint = parseFloat(crashPoint.toFixed(2));
                socket.spaceActive = true; socket.spaceCrash = crashPoint; socket.spaceBet = betAmount; socket.hasCashedOut = false; 
                socket.emit('start_spaceman', { crashPoint: crashPoint });
            });
        });
    });
    socket.on('cashout_spaceman', (data) => {
        if(!socket.spaceActive || socket.hasCashedOut) return; 
        const { stoppedAt } = data;
        if (stoppedAt <= socket.spaceCrash) {
            socket.hasCashedOut = true; 
            const winAmount = Math.floor(socket.spaceBet * stoppedAt);
            db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [winAmount, session.userId], () => {
                db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, u) => {
                    io.to(`user_${session.userId}`).emit('update_coin', u.coin); socket.emit('spaceman_cashed_out', { win: winAmount, multi: stoppedAt });
                });
            });
        }
    });
    socket.on('crash_spaceman', () => { socket.spaceActive = false; if (!socket.hasCashedOut) socket.emit('game_result', { game: 'spaceman', status: 'lose', msg: `💥 SPACEMAN HANCUR!` }); });
    
    socket.on('play_baccarat', (data) => {
        const { betAmount, choice } = data;
        if (betAmount > 1000000) return;
        db.get(`SELECT coin, status FROM users WHERE id = ?`, [session.userId], (err, user) => {
            if (user.status === 'BLOKIR' || user.coin < betAmount) return;
            db.run(`UPDATE users SET coin = coin - ? WHERE id = ?`, [betAmount, session.userId], () => {
                socket.emit('update_coin', user.coin - betAmount);
                setTimeout(() => {
                    const isWin = Math.random() < (rtpBandar.baccarat / 100);
                    let winner = choice;
                    if (!isWin) { const options = ['player', 'banker', 'tie'].filter(o => o !== choice); winner = options[Math.floor(Math.random() * options.length)]; }
                    let pScore = winner === 'player' ? Math.floor(Math.random()*4)+6 : Math.floor(Math.random()*6);
                    let bScore = winner === 'banker' ? Math.floor(Math.random()*4)+6 : Math.floor(Math.random()*6);
                    if (winner === 'tie') { pScore = 8; bScore = 8; }
                    if (isWin) {
                        let multi = choice === 'tie' ? 8 : (choice === 'banker' ? 1.95 : 2);
                        let winAmount = Math.floor(betAmount * multi);
                        db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [winAmount, session.userId], () => {
                            db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, u) => { io.to(`user_${session.userId}`).emit('update_coin', u.coin); socket.emit('game_result', { game: 'baccarat', status: 'win', msg: `🎉 WIN! ${winner.toUpperCase()}`, winner, pScore, bScore }); });
                        });
                    } else { socket.emit('game_result', { game: 'baccarat', status: 'lose', msg: `💀 ZONK! ${winner.toUpperCase()}`, winner, pScore, bScore }); }
                }, 1000); 
            });
        });
    });

    socket.on('play_roulette', (data) => {
        const { betAmount, color } = data;
        if (betAmount > 1000000) return;
        db.get(`SELECT coin, status FROM users WHERE id = ?`, [session.userId], (err, user) => {
            if (user.status === 'BLOKIR' || user.coin < betAmount) return;
            db.run(`UPDATE users SET coin = coin - ? WHERE id = ?`, [betAmount, session.userId], () => {
                socket.emit('update_coin', user.coin - betAmount);
                setTimeout(() => {
                    const isWin = Math.random() < (rtpBandar.roulette / 100);
                    const resColor = isWin ? color : (color === 'merah' ? 'hitam' : 'merah');
                    if (isWin) { db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [betAmount * 2, session.userId], () => { db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, u) => { io.to(`user_${session.userId}`).emit('update_coin', u.coin); socket.emit('game_result', { game: 'roulette', status: 'win', msg: `🎉 WIN! Keluar ${resColor.toUpperCase()}` }); }); });
                    } else socket.emit('game_result', { game: 'roulette', status: 'lose', msg: `💀 ZONK! Keluar ${resColor.toUpperCase()}` });
                }, 1500);
            });
        });
    });

    socket.on('play_coinflip', (data) => {
        const { betAmount, guess } = data;
        if (betAmount > 1000000) return;
        db.get(`SELECT coin, status FROM users WHERE id = ?`, [session.userId], (err, user) => {
            if (user.status === 'BLOKIR' || user.coin < betAmount) return;
            db.run(`UPDATE users SET coin = coin - ? WHERE id = ?`, [betAmount, session.userId], () => {
                socket.emit('update_coin', user.coin - betAmount);
                setTimeout(() => {
                    const isWin = Math.random() < (rtpBandar.coinflip / 100);
                    const res = isWin ? guess : (guess === 'angka' ? 'gambar' : 'angka');
                    if (isWin) { db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [Math.floor(betAmount * 1.9), session.userId], () => { db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, u) => { io.to(`user_${session.userId}`).emit('update_coin', u.coin); socket.emit('game_result', { game: 'coinflip', status: 'win', msg: `🎉 JP! Mendarat di ${res.toUpperCase()}` }); }); });
                    } else socket.emit('game_result', { game: 'coinflip', status: 'lose', msg: `💀 ZONK! Mendarat di ${res.toUpperCase()}` });
                }, 1500);
            });
        });
    });

    socket.on('play_spinwheel', (data) => {
        const betAmount = data.betAmount;
        if (betAmount > 1000000) return;
        db.get(`SELECT coin, status FROM users WHERE id = ?`, [session.userId], (err, user) => {
            if (user.status === 'BLOKIR' || user.coin < betAmount) return;
            db.run(`UPDATE users SET coin = coin - ? WHERE id = ?`, [betAmount, session.userId], () => {
                socket.emit('update_coin', user.coin - betAmount);
                setTimeout(() => {
                    const isWin = Math.random() < (rtpBandar.spinwheel / 100);
                    let multi = isWin ? [1.5, 2, 5][Math.floor(Math.random()*3)] : [0, 0, 0.5, 1][Math.floor(Math.random()*4)];
                    const win = Math.floor(betAmount * multi);
                    if (win > 0) { db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [win, session.userId], () => { db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, u) => { io.to(`user_${session.userId}`).emit('update_coin', u.coin); socket.emit('game_result', { game: 'spinwheel', status: multi >= 2 ? 'win' : 'lose', msg: `🎡 x${multi}! Dapat ${win.toLocaleString('id-ID')}` }); }); });
                    } else socket.emit('game_result', { game: 'spinwheel', status: 'lose', msg: `🎡 ZONK! Keluar x0` });
                }, 2000);
            });
        });
    });
});

server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log(`🚀 LGOLUX LIVE!`));
