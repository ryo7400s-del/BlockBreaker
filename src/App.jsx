import { addERC8021Attribution } from "./attribution.js";
import { useState, useEffect, useRef, useCallback } from "react";
import { createConfig, WagmiProvider, useAccount, useConnect, useDisconnect, useWalletClient, useSwitchChain, http } from "wagmi";
import { base } from "wagmi/chains";
import { injected, coinbaseWallet, walletConnect } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { encodeFunctionData } from "viem";



const GAME_CONTRACT = "0xD665F550C4697Fe628e3b362F8b43E8afd02bD4A";
const GAME_ABI = [
  { name: "stageClear", type: "function", inputs: [{ name: "stage", type: "uint8" }, { name: "choice", type: "uint8" }], outputs: [] },
  { name: "submitScore", type: "function", inputs: [{ name: "score", type: "uint32" }, { name: "maxStage", type: "uint8" }], outputs: [] }
];

const queryClient = new QueryClient();
const config = createConfig({
  chains: [base],
  connectors: [injected(), coinbaseWallet({ appName: "Block Breaker Onchain" }), walletConnect({ projectId: "YOUR_WC_PROJECT_ID" })],
  transports: { [base.id]: http() },
});

const CANVAS_W = 480, CANVAS_H = 520, PADDLE_W = 80, PADDLE_H = 10;
const BALL_R = 7, BALL_SPEED = 7.0, BLOCK_H = 22, BLOCK_GAP = 4;
const BLOCK_TOP = 60, LIVES_INIT = 3, TIME_INIT = 300;
const STAGE_GRIDS = [3, 4, 5, 6, 7];

function getGridForStage(s) { return s <= 5 ? STAGE_GRIDS[s - 1] : 7; }

function buildBlocks(stage) {
  const cols = getGridForStage(stage);
  const totalW = CANVAS_W - 40;
  const blockW = (totalW - (cols - 1) * BLOCK_GAP) / cols;
  const blocks = [];
  const bombIdx = Math.floor(Math.random() * cols * cols);
  let idx = 0;
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      blocks.push({ id: idx, x: 20 + c * (blockW + BLOCK_GAP), y: BLOCK_TOP + r * (BLOCK_H + BLOCK_GAP), w: blockW, h: BLOCK_H, alive: true, bomb: idx === bombIdx });
      idx++;
    }
  }
  return { blocks, cols, blockW };
}

function WalletPanel({ onConnected }) {
  const { connect, connectors } = useConnect();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  useEffect(() => { if (isConnected) { switchChain({ chainId: base.id }); onConnected(true); } }, [isConnected]);
  if (isConnected) return (
    <div style={styles.walletBar}>
      <span style={styles.walletAddr}>🔵 {address.slice(0,6)}...{address.slice(-4)}</span>
      <button style={styles.disconnectBtn} onClick={() => { disconnect(); onConnected(false); }}>切断</button>
    </div>
  );
  return (
    <div style={styles.walletPanel}>
      <div style={styles.walletTitle}>ウォレットを接続</div>
      {connectors.map(c => (
        <button key={c.id} style={styles.connectorBtn} onClick={() => connect({ connector: c })}>
          {c.name === "Injected" ? "🦊 MetaMask" : c.name === "Coinbase Wallet" ? "🔵 Coinbase Wallet" : "🔗 WalletConnect"}
        </button>
      ))}
    </div>
  );
}

function Game() {
  const canvasRef = useRef(null);
  const rootRef = useRef(null);

  const toggleFullscreen = () => { if (!document.fullscreenElement) { rootRef.current?.requestFullscreen?.(); } else { document.exitFullscreen?.(); } };
  const stateRef = useRef(null);
  const rafRef = useRef(null);
  const { data: walletClient } = useWalletClient();
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState("menu");
  const [lives, setLives] = useState(LIVES_INIT);
  const [timeLeft, setTimeLeft] = useState(TIME_INIT);
  const [score, setScore] = useState(0);
  const [stage, setStage] = useState(1);
  const [blocksLeft, setBlocksLeft] = useState(0);
  const [txPending, setTxPending] = useState(false);
  const [txMsg, setTxMsg] = useState("");
  const [ballCount, setBallCount] = useState(1);
  const [showChoice, setShowChoice] = useState(false);

  const initStage = useCallback((stageNum, livesVal, timeVal, scoreVal, ballsVal) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { blocks } = buildBlocks(stageNum);
    const balls = [];
    for (let i = 0; i < ballsVal; i++) {
      const angle = -Math.PI / 2 + (i - (ballsVal - 1) / 2) * 0.25;
      balls.push({ x: CANVAS_W / 2 + i * 15, y: CANVAS_H - 80, vx: Math.cos(angle) * BALL_SPEED, vy: Math.sin(angle) * BALL_SPEED, alive: true });
    }
    stateRef.current = { paddle: { x: CANVAS_W / 2 - PADDLE_W / 2, y: CANVAS_H - 40 }, balls, blocks, lives: livesVal, time: timeVal, score: scoreVal, stage: stageNum, lastTick: performance.now(), timerTick: performance.now(), running: true, mouseX: CANVAS_W / 2 };
    setLives(livesVal); setTimeLeft(timeVal); setScore(scoreVal); setStage(stageNum); setBallCount(ballsVal); setBlocksLeft(blocks.length);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onMove = (e) => { const rect = canvas.getBoundingClientRect(); if (stateRef.current) stateRef.current.mouseX = (e.clientX - rect.left) * (CANVAS_W / rect.width); };
    const onTouch = (e) => { e.preventDefault(); const rect = canvas.getBoundingClientRect(); if (stateRef.current && e.touches[0]) stateRef.current.mouseX = (e.touches[0].clientX - rect.left) * (CANVAS_W / rect.width); };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("touchmove", onTouch, { passive: true });
    return () => { canvas.removeEventListener("mousemove", onMove); canvas.removeEventListener("touchmove", onTouch); };
  }, []);

  const gameLoop = useCallback(() => {
    const s = stateRef.current;
    const canvas = canvasRef.current;
    if (!s || !canvas || !s.running) return;
    const ctx = canvas.getContext("2d");
    const now = performance.now();
    const dt = Math.min((now - s.lastTick) / 16.67, 3);
    s.lastTick = now;
    if (now - s.timerTick >= 1000) { s.time -= 1; s.timerTick = now; setTimeLeft(s.time); if (s.time <= 0) { s.running = false; setPhase("gameOver"); return; } }
    const targetX = Math.max(0, Math.min(CANVAS_W - PADDLE_W, s.mouseX - PADDLE_W / 2));
    const paddleSpeed = 18 * dt;
    const diff = targetX - s.paddle.x;
    s.paddle.x += Math.abs(diff) < paddleSpeed ? diff : Math.sign(diff) * paddleSpeed;
    for (const ball of s.balls) {
      if (!ball.alive) continue;
      ball.x += ball.vx * dt; ball.y += ball.vy * dt;
      if (ball.x - BALL_R < 0) { ball.x = BALL_R; ball.vx = Math.abs(ball.vx); }
      if (ball.x + BALL_R > CANVAS_W) { ball.x = CANVAS_W - BALL_R; ball.vx = -Math.abs(ball.vx); }
      if (ball.y - BALL_R < 0) { ball.y = BALL_R; ball.vy = Math.abs(ball.vy); }
      // 水平ループ防止: vyが小さすぎる場合は強制的に角度をつける
      if (Math.abs(ball.vy) < BALL_SPEED * 0.3) {
        ball.vy = ball.vy < 0 ? -BALL_SPEED * 0.3 : BALL_SPEED * 0.3;
        ball.vx = Math.sign(ball.vx) * Math.sqrt(BALL_SPEED * BALL_SPEED - ball.vy * ball.vy);
      }
      if (ball.y + BALL_R >= s.paddle.y && ball.y + BALL_R <= s.paddle.y + PADDLE_H + 6 && ball.x >= s.paddle.x && ball.x <= s.paddle.x + PADDLE_W && ball.vy > 0) {
        const hit = (ball.x - (s.paddle.x + PADDLE_W / 2)) / (PADDLE_W / 2);
        ball.vx = hit * BALL_SPEED * 1.2;
        // vxが大きすぎる場合は制限してvyに最小角度を保証
        const MIN_VY = BALL_SPEED * 0.4;
        ball.vx = Math.max(-BALL_SPEED * 0.9, Math.min(BALL_SPEED * 0.9, ball.vx));
        ball.vy = -Math.sqrt(Math.max(MIN_VY * MIN_VY, BALL_SPEED * BALL_SPEED - ball.vx * ball.vx));
        ball.y = s.paddle.y - BALL_R;
      }
      if (ball.y - BALL_R > CANVAS_H) ball.alive = false;
      for (const block of s.blocks) {
        if (!block.alive) continue;
        if (ball.x + BALL_R > block.x && ball.x - BALL_R < block.x + block.w && ball.y + BALL_R > block.y && ball.y - BALL_R < block.y + block.h) {
          block.alive = false; s.score += 10; setScore(s.score);
          if (block.bomb) { for (const o of s.blocks) { if (!o.alive) continue; if (Math.abs(o.x - block.x) <= block.w * 2 && Math.abs(o.y - block.y) <= block.h * 2) { o.alive = false; s.score += 10; } } setScore(s.score); }
          const ox = Math.min(ball.x + BALL_R - block.x, block.x + block.w - (ball.x - BALL_R));
          const oy = Math.min(ball.y + BALL_R - block.y, block.y + block.h - (ball.y - BALL_R));
          if (ox < oy) ball.vx *= -1; else ball.vy *= -1;
          break;
        }
      }
    }
    if (s.balls.every(b => !b.alive)) {
      s.lives -= 1; setLives(s.lives);
      if (s.lives <= 0) { s.running = false; setPhase("gameOver"); return; }
      for (let i = 0; i < s.balls.length; i++) {
        const angle = -Math.PI / 2 + (i - (s.balls.length - 1) / 2) * 0.25;
        s.balls[i] = { x: CANVAS_W / 2 + i * 15, y: CANVAS_H - 80, vx: Math.cos(angle) * BALL_SPEED, vy: Math.sin(angle) * BALL_SPEED, alive: true };
      }
    }
    const alive = s.blocks.filter(b => b.alive).length;
    setBlocksLeft(alive);
    if (alive === 0) { s.running = false; setPhase("stageClear"); setShowChoice(true); return; }
    const ctx2 = canvas.getContext("2d");
    ctx2.fillStyle = "#f8faff"; ctx2.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx2.strokeStyle = "rgba(0,100,255,0.04)"; ctx2.lineWidth = 1;
    for (let x = 0; x < CANVAS_W; x += 24) { ctx2.beginPath(); ctx2.moveTo(x,0); ctx2.lineTo(x,CANVAS_H); ctx2.stroke(); }
    for (let y = 0; y < CANVAS_H; y += 24) { ctx2.beginPath(); ctx2.moveTo(0,y); ctx2.lineTo(CANVAS_W,y); ctx2.stroke(); }
    for (const block of s.blocks) {
      if (!block.alive) continue;
      if (block.bomb) {
        const g = ctx2.createLinearGradient(block.x, block.y, block.x, block.y + block.h);
        g.addColorStop(0, "#ff4444"); g.addColorStop(1, "#cc0000");
        ctx2.fillStyle = g; ctx2.beginPath(); ctx2.roundRect(block.x+1, block.y+1, block.w-2, block.h-2, 4); ctx2.fill();
        ctx2.fillStyle = "white"; ctx2.font = `bold ${block.h*0.7}px monospace`; ctx2.textAlign = "center"; ctx2.textBaseline = "middle";
        ctx2.fillText("💣", block.x + block.w/2, block.y + block.h/2);
      } else {
        const col = s.stage % 3;
        const colors = [["#1a6fff","#0047cc"],["#0ea5e9","#0369a1"],["#3b82f6","#1d4ed8"]];
        const g = ctx2.createLinearGradient(block.x, block.y, block.x, block.y + block.h);
        g.addColorStop(0, colors[col][0]); g.addColorStop(1, colors[col][1]);
        ctx2.fillStyle = g; ctx2.beginPath(); ctx2.roundRect(block.x+1, block.y+1, block.w-2, block.h-2, 4); ctx2.fill();
        ctx2.fillStyle = "rgba(255,255,255,0.18)"; ctx2.beginPath(); ctx2.roundRect(block.x+2, block.y+2, block.w-4, (block.h-4)/2, 3); ctx2.fill();
      }
    }
    const pg = ctx2.createLinearGradient(s.paddle.x, s.paddle.y, s.paddle.x, s.paddle.y + PADDLE_H);
    pg.addColorStop(0, "#2563eb"); pg.addColorStop(1, "#1d4ed8");
    ctx2.fillStyle = pg; ctx2.shadowColor = "rgba(37,99,235,0.5)"; ctx2.shadowBlur = 12;
    ctx2.beginPath(); ctx2.roundRect(s.paddle.x, s.paddle.y, PADDLE_W, PADDLE_H, 5); ctx2.fill(); ctx2.shadowBlur = 0;
    for (const ball of s.balls) {
      if (!ball.alive) continue;
      ctx2.fillStyle = "#ffffff"; ctx2.shadowColor = "rgba(37,99,235,0.8)"; ctx2.shadowBlur = 16;
      ctx2.beginPath(); ctx2.arc(ball.x, ball.y, BALL_R, 0, Math.PI*2); ctx2.fill();
      ctx2.strokeStyle = "#2563eb"; ctx2.lineWidth = 2; ctx2.stroke(); ctx2.shadowBlur = 0;
    }
    ctx2.fillStyle = "rgba(248,250,255,0.9)"; ctx2.fillRect(0, 0, CANVAS_W, 50);
    ctx2.font = "bold 13px 'Courier New',monospace"; ctx2.fillStyle = "#1e40af"; ctx2.textAlign = "left";
    ctx2.fillText(`STAGE ${s.stage}`, 14, 20); ctx2.fillText(`❤️ ${s.lives}`, 14, 38);
    ctx2.textAlign = "center"; ctx2.fillStyle = s.time <= 30 ? "#ef4444" : "#1e40af"; ctx2.font = "bold 18px 'Courier New',monospace";
    ctx2.fillText(`${String(Math.floor(s.time/60)).padStart(2,"0")}:${String(s.time%60).padStart(2,"0")}`, CANVAS_W/2, 30);
    ctx2.textAlign = "right"; ctx2.font = "bold 13px 'Courier New',monospace"; ctx2.fillStyle = "#1e40af";
    ctx2.fillText(`SCORE ${s.score}`, CANVAS_W-14, 20); ctx2.fillText(`🎯 ${s.balls.length}球`, CANVAS_W-14, 38);
    rafRef.current = requestAnimationFrame(gameLoop);
  }, []);

  const sendTx = async (functionName, args) => {
    if (!walletClient) throw new Error("ウォレット未接続");
    const data = encodeFunctionData({ abi: GAME_ABI, functionName, args });
    const attributed = addERC8021Attribution(data);
    const chainId = await walletClient.getChainId();
    if (chainId !== base.id) throw new Error(`Baseに切り替えてください (現在: ${chainId})`);
    return await walletClient.sendTransaction({ to: GAME_CONTRACT, data: attributed });
  };

  const handleChoice = async (choiceIdx) => {
    if (!walletClient || txPending) return;
    setTxPending(true); setTxMsg("ウォレットを確認してください...");
    try {
      await sendTx("stageClear", [stateRef.current?.stage || stage, choiceIdx]);
      setTxMsg("✅ ブロックチェーンに記録しました！");
      await new Promise(r => setTimeout(r, 1200));
      const s = stateRef.current;
      let newLives = s ? s.lives : lives, newTime = s ? s.time : timeLeft, newBalls = s ? s.balls.length : ballCount;
      if (choiceIdx === 0) newLives++; else if (choiceIdx === 1) newBalls++; else newTime += 30;
      const nextStage = (s ? s.stage : stage) + 1;
      setShowChoice(false); setPhase("playing");
      setTimeout(() => { initStage(nextStage, newLives, newTime, s ? s.score : score, newBalls); rafRef.current = requestAnimationFrame(gameLoop); }, 50);
    } catch (e) { setTxMsg("❌ " + (e.shortMessage || e.message || "エラー")); }
    finally { setTxPending(false); }
  };

  const submitScore = async () => {
    if (!walletClient || txPending) return;
    setTxPending(true); setTxMsg("ウォレットを確認してください...");
    try {
      const s = stateRef.current;
      await sendTx("submitScore", [s ? s.score : score, s ? s.stage : stage]);
      setTxMsg("✅ スコアをBaseに記録しました！");
    } catch (e) { setTxMsg("❌ " + (e.shortMessage || e.message || "エラー")); }
    finally { setTxPending(false); }
  };

  const startGame = () => { setPhase("playing"); setTimeout(() => { initStage(1, LIVES_INIT, TIME_INIT, 0, 1); rafRef.current = requestAnimationFrame(gameLoop); }, 50); };
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);
  useEffect(() => { return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }; }, []);

  return (
    <div style={styles.root} ref={rootRef}>
      <div style={styles.header}>
        <div style={styles.logo}><span style={styles.logoIcon}>🔵</span><span style={styles.logoText}>BLOCK BREAKER</span><span style={styles.logoSub}>ONCHAIN</span></div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <button style={styles.fullscreenBtn} onClick={toggleFullscreen} title="フルスクリーン">⛶</button>
          <WalletPanel onConnected={setConnected} />
        </div>
      </div>
      <div style={styles.gameArea}>
        <div style={styles.canvasWrap}>
          <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} style={styles.canvas} />
          {phase === "menu" && <div style={styles.overlay}><div style={styles.menuCard}>
            <div style={styles.menuTitle}>BLOCK BREAKER</div>
            <div style={styles.menuSub}>ONCHAIN × BASE</div>
            <div style={styles.menuRules}><div>🔵 5ステージ (3×3〜7×7)</div><div>❤️ 残機3つ / ⏱️ 制限5分</div><div>💣 爆弾ブロックで連鎖破壊</div><div>⛓️ ステージクリアをオンチェーン記録</div></div>
            {connected ? <button style={styles.startBtn} onClick={startGame}>PLAY ON BASE</button> : <div style={styles.connectPrompt}>ウォレットを接続してプレイ</div>}
          </div></div>}
          {phase === "stageClear" && showChoice && <div style={styles.overlay}><div style={styles.clearCard}>
            <div style={styles.clearTitle}>⭐ STAGE {stage} CLEAR!</div>
            <div style={styles.clearScore}>SCORE: {score}</div>
            <div style={styles.choiceTitle}>パワーアップを選択</div>
            <div style={styles.choiceNote}>選択はブロックチェーンに記録されます</div>
            <div style={styles.choiceGrid}>
              {[{icon:"❤️",label:"残機+1",sub:"Extra Life",idx:0},{icon:"🎱",label:"ボール追加",sub:"Extra Ball",idx:1},{icon:"⏱️",label:"+30秒",sub:"Time Extend",idx:2}].map(c => (
                <button key={c.idx} style={{...styles.choiceBtn, opacity: txPending ? 0.6 : 1}} onClick={() => handleChoice(c.idx)} disabled={txPending}>
                  <div style={styles.choiceIcon}>{c.icon}</div><div style={styles.choiceLabel}>{c.label}</div><div style={styles.choiceSub}>{c.sub}</div>
                </button>
              ))}
            </div>
            {txMsg && <div style={styles.txMsg}>{txMsg}</div>}
            {txPending && <div style={styles.spinner}>⏳ 処理中...</div>}
          </div></div>}
          {phase === "gameOver" && <div style={styles.overlay}><div style={styles.overCard}>
            <div style={styles.overTitle}>GAME OVER</div>
            <div style={styles.overScore}>SCORE: {score}</div>
            <div style={styles.overStage}>STAGE: {stage}</div>
            {txMsg && <div style={styles.txMsg}>{txMsg}</div>}
            <button style={{...styles.submitBtn, opacity: txPending ? 0.6 : 1}} onClick={submitScore} disabled={txPending || !walletClient}>{txPending ? "送信中..." : "⛓️ スコアを記録する"}</button>
            <button style={styles.retryBtn} onClick={startGame}>もう一度プレイ</button>
          </div></div>}
        </div>
        <div style={styles.sidePanel}>
          {[["STAGE",stage],["SCORE",score],["LIVES","❤️".repeat(Math.max(0,lives))],["TIME",`${String(Math.floor(timeLeft/60)).padStart(2,"0")}:${String(timeLeft%60).padStart(2,"0")}`],["BALLS",ballCount],["BLOCKS",blocksLeft]].map(([label,val]) => (
            <div key={label} style={{...styles.statCard,...(label==="TIME"&&timeLeft<=30?styles.danger:{})}}><div style={styles.statLabel}>{label}</div><div style={styles.statValue}>{val}</div></div>
          ))}
          <div style={styles.infoCard}><div style={styles.infoTitle}>⛓️ Base Onchain</div><div style={styles.infoText}>ステージクリア時の選択がBaseに永久記録されます</div></div>
          <div style={styles.infoCard}><div style={styles.infoTitle}>💣 爆弾ブロック</div><div style={styles.infoText}>破壊すると周囲2×2も連鎖破壊！</div></div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  root:{minHeight:"100vh",background:"linear-gradient(135deg,#f0f4ff 0%,#ffffff 50%,#f0f8ff 100%)",fontFamily:"'Courier New','Consolas',monospace",color:"#1e3a8a"},
  header:{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 24px",background:"rgba(255,255,255,0.9)",backdropFilter:"blur(12px)",borderBottom:"1px solid rgba(37,99,235,0.15)",flexWrap:"wrap",gap:8},
  logo:{display:"flex",alignItems:"center",gap:8},logoIcon:{fontSize:22},logoText:{fontSize:18,fontWeight:900,letterSpacing:3,color:"#1d4ed8"},logoSub:{fontSize:10,letterSpacing:2,color:"#60a5fa",background:"#eff6ff",padding:"2px 6px",borderRadius:4},
  walletBar:{display:"flex",alignItems:"center",gap:10},walletAddr:{fontSize:12,color:"#2563eb",background:"#eff6ff",padding:"4px 10px",borderRadius:6,border:"1px solid rgba(37,99,235,0.2)"},disconnectBtn:{fontSize:11,padding:"4px 10px",background:"transparent",border:"1px solid #cbd5e1",borderRadius:6,cursor:"pointer",color:"#64748b"},
  walletPanel:{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"},walletTitle:{fontSize:12,color:"#64748b"},connectorBtn:{fontSize:12,padding:"6px 12px",background:"#1d4ed8",color:"white",border:"none",borderRadius:6,cursor:"pointer",fontFamily:"inherit",fontWeight:600},
  gameArea:{display:"flex",justifyContent:"center",alignItems:"flex-start",gap:20,padding:"20px",flexWrap:"wrap"},
  canvasWrap:{position:"relative",borderRadius:12,overflow:"hidden",boxShadow:"0 8px 40px rgba(37,99,235,0.18),0 2px 8px rgba(0,0,0,0.08)",border:"2px solid rgba(37,99,235,0.2)"},canvas:{display:"block",maxWidth:"100%",cursor:"none"},
  overlay:{position:"absolute",inset:0,background:"rgba(240,244,255,0.92)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center"},
  menuCard:{background:"white",borderRadius:16,padding:"32px 28px",textAlign:"center",border:"2px solid rgba(37,99,235,0.2)",boxShadow:"0 8px 32px rgba(37,99,235,0.12)",maxWidth:320},
  menuTitle:{fontSize:26,fontWeight:900,letterSpacing:4,color:"#1d4ed8",marginBottom:4},menuSub:{fontSize:11,letterSpacing:3,color:"#60a5fa",marginBottom:20},
  menuRules:{textAlign:"left",fontSize:13,lineHeight:2,color:"#374151",marginBottom:24,background:"#f8faff",padding:"12px 16px",borderRadius:8},
  startBtn:{width:"100%",padding:"14px",background:"linear-gradient(135deg,#2563eb,#1d4ed8)",color:"white",border:"none",borderRadius:10,fontSize:16,fontWeight:900,letterSpacing:3,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 4px 16px rgba(37,99,235,0.4)"},
  connectPrompt:{color:"#64748b",fontSize:13,padding:"12px",background:"#f1f5f9",borderRadius:8},
  clearCard:{background:"white",borderRadius:16,padding:"28px 24px",textAlign:"center",border:"2px solid rgba(37,99,235,0.2)",boxShadow:"0 8px 32px rgba(37,99,235,0.15)",maxWidth:360,width:"90%"},
  clearTitle:{fontSize:22,fontWeight:900,color:"#1d4ed8",letterSpacing:2,marginBottom:4},clearScore:{fontSize:14,color:"#64748b",marginBottom:16},
  choiceTitle:{fontSize:13,fontWeight:700,color:"#1e3a8a",marginBottom:4},choiceNote:{fontSize:10,color:"#93c5fd",marginBottom:14},
  choiceGrid:{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12},
  choiceBtn:{background:"linear-gradient(135deg,#eff6ff,#dbeafe)",border:"2px solid rgba(37,99,235,0.25)",borderRadius:10,padding:"12px 6px",cursor:"pointer",fontFamily:"inherit"},
  choiceIcon:{fontSize:22,marginBottom:4},choiceLabel:{fontSize:11,fontWeight:700,color:"#1d4ed8"},choiceSub:{fontSize:9,color:"#60a5fa",marginTop:2},
  txMsg:{fontSize:12,color:"#059669",background:"#f0fdf4",padding:"8px 12px",borderRadius:6,marginTop:8},spinner:{fontSize:12,color:"#64748b",marginTop:8},
  overCard:{background:"white",borderRadius:16,padding:"32px 28px",textAlign:"center",border:"2px solid rgba(239,68,68,0.3)",boxShadow:"0 8px 32px rgba(239,68,68,0.12)",maxWidth:300},
  overTitle:{fontSize:28,fontWeight:900,letterSpacing:4,color:"#ef4444",marginBottom:8},overScore:{fontSize:18,fontWeight:700,color:"#1d4ed8",marginBottom:4},overStage:{fontSize:13,color:"#64748b",marginBottom:20},
  submitBtn:{width:"100%",padding:"12px",background:"linear-gradient(135deg,#2563eb,#1d4ed8)",color:"white",border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit",marginBottom:10,letterSpacing:1},
  fullscreenBtn:{fontSize:18,padding:"4px 8px",background:"transparent",border:"1px solid rgba(37,99,235,0.3)",borderRadius:6,cursor:"pointer",color:"#2563eb"},
  retryBtn:{width:"100%",padding:"10px",background:"transparent",color:"#2563eb",border:"2px solid rgba(37,99,235,0.3)",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"},
  sidePanel:{display:"flex",flexDirection:"column",gap:10,minWidth:140,maxWidth:160},
  statCard:{background:"white",border:"1px solid rgba(37,99,235,0.15)",borderRadius:10,padding:"10px 14px",boxShadow:"0 2px 8px rgba(37,99,235,0.06)"},danger:{borderColor:"rgba(239,68,68,0.4)",background:"#fff5f5"},
  statLabel:{fontSize:9,letterSpacing:2,color:"#93c5fd",fontWeight:700,marginBottom:2},statValue:{fontSize:18,fontWeight:900,color:"#1d4ed8",letterSpacing:1},
  infoCard:{background:"#eff6ff",border:"1px solid rgba(37,99,235,0.15)",borderRadius:10,padding:"10px 14px",marginTop:4},infoTitle:{fontSize:11,fontWeight:700,color:"#1d4ed8",marginBottom:4},infoText:{fontSize:10,color:"#3b82f6",lineHeight:1.5},
};

export default function App() {
  return <WagmiProvider config={config}><QueryClientProvider client={queryClient}><Game /></QueryClientProvider></WagmiProvider>;
}
