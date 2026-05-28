import { useState, useEffect, useRef, useCallback } from "react";
import { createConfig, WagmiProvider, useAccount, useConnect, useDisconnect, useWalletClient, useSwitchChain, http } from "wagmi";
import { base } from "wagmi/chains";
import { injected, coinbaseWallet, walletConnect } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { encodeFunctionData } from "viem";

// ─── ERC-8021 Attribution ───────────────────────────────────────────────────
const BUILDER_CODE = "bc_dw8n1qvm";
function addERC8021Attribution(existingData) {
  // Manual attribution suffix since ox package not available in artifact
  const codeHex = Array.from(new TextEncoder().encode(BUILDER_CODE))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  const suffix = "ef" + "01" + codeHex.padEnd(64, "0");
  const base = existingData.startsWith("0x") ? existingData.slice(2) : existingData;
  return "0x" + base + suffix;
}

// ─── Contract Config ────────────────────────────────────────────────────────
const GAME_CONTRACT = "0xD665F550C4697Fe628e3b362F8b43E8afd02bD4A";
const PAYMASTER_CONTRACT = "0x44d1258558ad044A4a769eFea1A3657f5D72B5C0";

const GAME_ABI = [
  {
    name: "stageClear",
    type: "function",
    inputs: [
      { name: "stage", type: "uint8" },
      { name: "choice", type: "uint8" }
    ],
    outputs: []
  },
  {
    name: "submitScore",
    type: "function",
    inputs: [
      { name: "score", type: "uint32" },
      { name: "maxStage", type: "uint8" }
    ],
    outputs: []
  }
];

// ─── Wagmi Config ────────────────────────────────────────────────────────────
const queryClient = new QueryClient();
const config = createConfig({
  chains: [base],
  connectors: [
    injected(),
    coinbaseWallet({ appName: "Block Breaker Onchain" }),
    walletConnect({ projectId: "YOUR_WC_PROJECT_ID" }),
  ],
  transports: { [base.id]: http() },
});

// ─── Game Constants ──────────────────────────────────────────────────────────
const CANVAS_W = 480;
const CANVAS_H = 520;
const PADDLE_W = 80;
const PADDLE_H = 10;
const BALL_R = 7;
const BALL_SPEED = 4.5;
const STAGE_GRIDS = [3, 4, 5, 6, 7];
const BLOCK_H = 22;
const BLOCK_GAP = 4;
const BLOCK_TOP = 60;
const LIVES_INIT = 3;
const TIME_INIT = 300;

function getGridForStage(stage) {
  return stage <= 5 ? STAGE_GRIDS[stage - 1] : 7;
}

function buildBlocks(stage) {
  const cols = getGridForStage(stage);
  const totalW = CANVAS_W - 40;
  const blockW = (totalW - (cols - 1) * BLOCK_GAP) / cols;
  const blocks = [];
  const bombIdx = Math.floor(Math.random() * cols * cols);
  let idx = 0;
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      blocks.push({
        id: idx,
        x: 20 + c * (blockW + BLOCK_GAP),
        y: BLOCK_TOP + r * (BLOCK_H + BLOCK_GAP),
        w: blockW,
        h: BLOCK_H,
        alive: true,
        bomb: idx === bombIdx,
      });
      idx++;
    }
  }
  return { blocks, cols, blockW };
}

// ─── Wallet Connect Panel ────────────────────────────────────────────────────
function WalletPanel({ onConnected }) {
  const { connect, connectors } = useConnect();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  useEffect(() => {
    if (isConnected) {
      switchChain({ chainId: base.id });
      onConnected(true);
    }
  }, [isConnected]);

  if (isConnected) {
    return (
      <div style={styles.walletBar}>
        <span style={styles.walletAddr}>
          🔵 {address.slice(0, 6)}...{address.slice(-4)}
        </span>
        <button style={styles.disconnectBtn} onClick={() => { disconnect(); onConnected(false); }}>
          切断
        </button>
      </div>
    );
  }

  return (
    <div style={styles.walletPanel}>
      <div style={styles.walletTitle}>ウォレットを接続</div>
      {connectors.map(c => (
        <button key={c.id} style={styles.connectorBtn} onClick={() => connect({ connector: c })}>
          {c.name === "Injected" ? "🦊 MetaMask" :
           c.name === "Coinbase Wallet" ? "🔵 Coinbase Wallet" :
           "🔗 WalletConnect"}
        </button>
      ))}
    </div>
  );
}

// ─── Main Game Component ─────────────────────────────────────────────────────
function Game() {
  const canvasRef = useRef(null);
  const stateRef = useRef(null);
  const rafRef = useRef(null);
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState("menu"); // menu | playing | stageClear | gameOver | leaderboard
  const [lives, setLives] = useState(LIVES_INIT);
  const [timeLeft, setTimeLeft] = useState(TIME_INIT);
  const [score, setScore] = useState(0);
  const [stage, setStage] = useState(1);
  const [blocksLeft, setBlocksLeft] = useState(0);
  const [txPending, setTxPending] = useState(false);
  const [txMsg, setTxMsg] = useState("");
  const [ballCount, setBallCount] = useState(1);
  const [showChoice, setShowChoice] = useState(false);

  // ── Init game state ────────────────────────────────────────────────────────
  const initStage = useCallback((stageNum, livesVal, timeVal, scoreVal, ballsVal) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const { blocks, cols, blockW } = buildBlocks(stageNum);

    const balls = [];
    for (let i = 0; i < ballsVal; i++) {
      const angle = -Math.PI / 2 + (i - (ballsVal - 1) / 2) * 0.25;
      balls.push({
        x: CANVAS_W / 2 + i * 15,
        y: CANVAS_H - 80,
        vx: Math.cos(angle) * BALL_SPEED,
        vy: Math.sin(angle) * BALL_SPEED,
      });
    }

    stateRef.current = {
      paddle: { x: CANVAS_W / 2 - PADDLE_W / 2, y: CANVAS_H - 40 },
      balls,
      blocks,
      cols,
      blockW,
      lives: livesVal,
      time: timeVal,
      score: scoreVal,
      stage: stageNum,
      ballCount: ballsVal,
      lastTick: performance.now(),
      timerTick: performance.now(),
      running: true,
      mouseX: CANVAS_W / 2,
    };

    setLives(livesVal);
    setTimeLeft(timeVal);
    setScore(scoreVal);
    setStage(stageNum);
    setBallCount(ballsVal);
    setBlocksLeft(blocks.length);
  }, []);

  // ── Mouse move ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = CANVAS_W / rect.width;
      if (stateRef.current) {
        stateRef.current.mouseX = (e.clientX - rect.left) * scaleX;
      }
    };
    const onTouch = (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = CANVAS_W / rect.width;
      if (stateRef.current && e.touches[0]) {
        stateRef.current.mouseX = (e.touches[0].clientX - rect.left) * scaleX;
      }
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("touchmove", onTouch, { passive: true });
    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("touchmove", onTouch);
    };
  }, []);

  // ── Game loop ──────────────────────────────────────────────────────────────
  const gameLoop = useCallback(() => {
    const s = stateRef.current;
    const canvas = canvasRef.current;
    if (!s || !canvas || !s.running) return;
    const ctx = canvas.getContext("2d");
    const now = performance.now();
    const dt = Math.min((now - s.lastTick) / 16.67, 3);
    s.lastTick = now;

    // Timer
    if (now - s.timerTick >= 1000) {
      s.time -= 1;
      s.timerTick = now;
      setTimeLeft(s.time);
      if (s.time <= 0) {
        s.running = false;
        setPhase("gameOver");
        return;
      }
    }

    // Paddle
    s.paddle.x = Math.max(0, Math.min(CANVAS_W - PADDLE_W, s.mouseX - PADDLE_W / 2));

    // Balls
    let aliveBalls = 0;
    for (const ball of s.balls) {
      if (!ball.alive) continue;
      aliveBalls++;
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;

      // Wall bounce
      if (ball.x - BALL_R < 0) { ball.x = BALL_R; ball.vx = Math.abs(ball.vx); }
      if (ball.x + BALL_R > CANVAS_W) { ball.x = CANVAS_W - BALL_R; ball.vx = -Math.abs(ball.vx); }
      if (ball.y - BALL_R < 0) { ball.y = BALL_R; ball.vy = Math.abs(ball.vy); }

      // Paddle bounce
      if (
        ball.y + BALL_R >= s.paddle.y &&
        ball.y + BALL_R <= s.paddle.y + PADDLE_H + 6 &&
        ball.x >= s.paddle.x &&
        ball.x <= s.paddle.x + PADDLE_W &&
        ball.vy > 0
      ) {
        const hit = (ball.x - (s.paddle.x + PADDLE_W / 2)) / (PADDLE_W / 2);
        ball.vx = hit * BALL_SPEED * 1.2;
        ball.vy = -Math.sqrt(Math.max(0, BALL_SPEED * BALL_SPEED - ball.vx * ball.vx));
        ball.y = s.paddle.y - BALL_R;
      }

      // Ball lost
      if (ball.y - BALL_R > CANVAS_H) {
        ball.alive = false;
      }

      // Block collision
      for (const block of s.blocks) {
        if (!block.alive) continue;
        if (
          ball.x + BALL_R > block.x &&
          ball.x - BALL_R < block.x + block.w &&
          ball.y + BALL_R > block.y &&
          ball.y - BALL_R < block.y + block.h
        ) {
          block.alive = false;
          s.score += 10;
          setScore(s.score);

          // Bomb effect
          if (block.bomb) {
            for (const other of s.blocks) {
              if (!other.alive) continue;
              if (
                Math.abs(other.x - block.x) <= block.w * 2 &&
                Math.abs(other.y - block.y) <= block.h * 2
              ) {
                other.alive = false;
                s.score += 10;
              }
            }
            setScore(s.score);
          }

          // Bounce
          const overlapX = Math.min(ball.x + BALL_R - block.x, block.x + block.w - (ball.x - BALL_R));
          const overlapY = Math.min(ball.y + BALL_R - block.y, block.y + block.h - (ball.y - BALL_R));
          if (overlapX < overlapY) ball.vx *= -1;
          else ball.vy *= -1;
          break;
        }
      }
    }

    // All balls lost
    const deadBalls = s.balls.filter(b => !b.alive).length;
    if (deadBalls === s.balls.length) {
      s.lives -= 1;
      setLives(s.lives);
      if (s.lives <= 0) {
        s.running = false;
        setPhase("gameOver");
        return;
      }
      // Respawn balls
      for (let i = 0; i < s.balls.length; i++) {
        const angle = -Math.PI / 2 + (i - (s.balls.length - 1) / 2) * 0.25;
        s.balls[i] = {
          x: CANVAS_W / 2 + i * 15,
          y: CANVAS_H - 80,
          vx: Math.cos(angle) * BALL_SPEED,
          vy: Math.sin(angle) * BALL_SPEED,
          alive: true,
        };
      }
    }

    // Stage clear
    const aliveBlocks = s.blocks.filter(b => b.alive).length;
    setBlocksLeft(aliveBlocks);
    if (aliveBlocks === 0) {
      s.running = false;
      setPhase("stageClear");
      setShowChoice(true);
      return;
    }

    // Draw
    draw(ctx, s);
    rafRef.current = requestAnimationFrame(gameLoop);
  }, []);

  // ── Draw ───────────────────────────────────────────────────────────────────
  function draw(ctx, s) {
    // Background
    ctx.fillStyle = "#f8faff";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Grid lines subtle
    ctx.strokeStyle = "rgba(0,100,255,0.04)";
    ctx.lineWidth = 1;
    for (let x = 0; x < CANVAS_W; x += 24) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
    }
    for (let y = 0; y < CANVAS_H; y += 24) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
    }

    // Blocks
    for (const block of s.blocks) {
      if (!block.alive) continue;
      if (block.bomb) {
        // Bomb block
        const grd = ctx.createLinearGradient(block.x, block.y, block.x, block.y + block.h);
        grd.addColorStop(0, "#ff4444");
        grd.addColorStop(1, "#cc0000");
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.roundRect(block.x + 1, block.y + 1, block.w - 2, block.h - 2, 4);
        ctx.fill();
        ctx.fillStyle = "white";
        ctx.font = `bold ${block.h * 0.7}px monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("💣", block.x + block.w / 2, block.y + block.h / 2);
      } else {
        const col = s.stage % 3;
        const colors = [
          ["#1a6fff", "#0047cc"],
          ["#0ea5e9", "#0369a1"],
          ["#3b82f6", "#1d4ed8"],
        ];
        const grd = ctx.createLinearGradient(block.x, block.y, block.x, block.y + block.h);
        grd.addColorStop(0, colors[col][0]);
        grd.addColorStop(1, colors[col][1]);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.roundRect(block.x + 1, block.y + 1, block.w - 2, block.h - 2, 4);
        ctx.fill();
        // Shine
        ctx.fillStyle = "rgba(255,255,255,0.18)";
        ctx.beginPath();
        ctx.roundRect(block.x + 2, block.y + 2, block.w - 4, (block.h - 4) / 2, 3);
        ctx.fill();
      }
    }

    // Paddle
    const pg = ctx.createLinearGradient(s.paddle.x, s.paddle.y, s.paddle.x, s.paddle.y + PADDLE_H);
    pg.addColorStop(0, "#2563eb");
    pg.addColorStop(1, "#1d4ed8");
    ctx.fillStyle = pg;
    ctx.shadowColor = "rgba(37,99,235,0.5)";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.roundRect(s.paddle.x, s.paddle.y, PADDLE_W, PADDLE_H, 5);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Balls
    for (const ball of s.balls) {
      if (!ball.alive) continue;
      ctx.fillStyle = "#ffffff";
      ctx.shadowColor = "rgba(37,99,235,0.8)";
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // HUD top bar
    ctx.fillStyle = "rgba(248,250,255,0.9)";
    ctx.fillRect(0, 0, CANVAS_W, 50);
    ctx.strokeStyle = "rgba(37,99,235,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, 50); ctx.lineTo(CANVAS_W, 50); ctx.stroke();

    ctx.font = "bold 13px 'Courier New', monospace";
    ctx.fillStyle = "#1e40af";
    ctx.textAlign = "left";
    ctx.fillText(`STAGE ${s.stage}`, 14, 20);
    ctx.fillText(`❤️ ${s.lives}`, 14, 38);

    ctx.textAlign = "center";
    ctx.fillStyle = s.time <= 30 ? "#ef4444" : "#1e40af";
    ctx.font = "bold 18px 'Courier New', monospace";
    const m = Math.floor(s.time / 60).toString().padStart(2, "0");
    const sec = (s.time % 60).toString().padStart(2, "0");
    ctx.fillText(`${m}:${sec}`, CANVAS_W / 2, 30);

    ctx.textAlign = "right";
    ctx.font = "bold 13px 'Courier New', monospace";
    ctx.fillStyle = "#1e40af";
    ctx.fillText(`SCORE ${s.score}`, CANVAS_W - 14, 20);
    ctx.fillText(`🎯 ${s.balls.length}球`, CANVAS_W - 14, 38);
  }

  // ── Start game ─────────────────────────────────────────────────────────────
  const startGame = () => {
    setPhase("playing");
    setTimeout(() => {
      initStage(1, LIVES_INIT, TIME_INIT, 0, 1);
      rafRef.current = requestAnimationFrame(gameLoop);
    }, 50);
  };

  // ── Stage clear choice + TX ────────────────────────────────────────────────
  const handleChoice = async (choiceIdx) => {
    if (!walletClient || txPending) return;
    setTxPending(true);
    setTxMsg("トランザクション送信中...");
    try {
      const data = encodeFunctionData({
        abi: GAME_ABI,
        functionName: "stageClear",
        args: [stateRef.current?.stage || stage, choiceIdx],
      });
      const attributedData = addERC8021Attribution(data);
      await walletClient.sendTransaction({
        to: GAME_CONTRACT,
        data: attributedData,
        chain: base,
      });
      setTxMsg("✅ ブロックチェーンに記録しました！");
      await new Promise(r => setTimeout(r, 1200));

      // Apply choice
      const s = stateRef.current;
      let newLives = s ? s.lives : lives;
      let newTime = s ? s.time : timeLeft;
      let newBalls = s ? s.balls.length : ballCount;

      if (choiceIdx === 0) newLives += 1;
      else if (choiceIdx === 1) newBalls += 1;
      else if (choiceIdx === 2) newTime += 30;

      const nextStage = (s ? s.stage : stage) + 1;
      setShowChoice(false);
      setPhase("playing");
      setTimeout(() => {
        initStage(nextStage, newLives, newTime, s ? s.score : score, newBalls);
        rafRef.current = requestAnimationFrame(gameLoop);
      }, 50);
    } catch (e) {
      setTxMsg("❌ " + (e.shortMessage || e.message || "エラーが発生しました"));
    } finally {
      setTxPending(false);
    }
  };

  // ── Game over TX ───────────────────────────────────────────────────────────
  const submitScore = async () => {
    if (!walletClient || txPending) return;
    setTxPending(true);
    setTxMsg("スコア記録中...");
    try {
      const s = stateRef.current;
      const finalScore = s ? s.score : score;
      const finalStage = s ? s.stage : stage;
      const data = encodeFunctionData({
        abi: GAME_ABI,
        functionName: "submitScore",
        args: [finalScore, finalStage],
      });
      const attributedData = addERC8021Attribution(data);
      await walletClient.sendTransaction({
        to: GAME_CONTRACT,
        data: attributedData,
        chain: base,
      });
      setTxMsg("✅ スコアを記録しました！");
    } catch (e) {
      setTxMsg("❌ " + (e.shortMessage || e.message || "エラー"));
    } finally {
      setTxPending(false);
    }
  };

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  useEffect(() => {
    if (phase === "playing" && stateRef.current) {
      stateRef.current.running = true;
      rafRef.current = requestAnimationFrame(gameLoop);
    }
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [phase, gameLoop]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.logo}>
          <span style={styles.logoIcon}>🔵</span>
          <span style={styles.logoText}>BLOCK BREAKER</span>
          <span style={styles.logoSub}>ONCHAIN</span>
        </div>
        <WalletPanel onConnected={setConnected} />
      </div>

      {/* Game Area */}
      <div style={styles.gameArea}>
        {/* Canvas */}
        <div style={styles.canvasWrap}>
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            style={styles.canvas}
          />

          {/* Menu Overlay */}
          {phase === "menu" && (
            <div style={styles.overlay}>
              <div style={styles.menuCard}>
                <div style={styles.menuTitle}>BLOCK BREAKER</div>
                <div style={styles.menuSub}>ONCHAIN × BASE</div>
                <div style={styles.menuRules}>
                  <div>🔵 5ステージ制 (3×3〜7×7)</div>
                  <div>❤️ 残機3つ / ⏱️ 制限5分</div>
                  <div>💣 爆弾ブロックで周囲を破壊</div>
                  <div>⛓️ ステージクリアをオンチェーン記録</div>
                </div>
                {connected ? (
                  <button style={styles.startBtn} onClick={startGame}>
                    PLAY ON BASE
                  </button>
                ) : (
                  <div style={styles.connectPrompt}>ウォレットを接続してプレイ</div>
                )}
              </div>
            </div>
          )}

          {/* Stage Clear Overlay */}
          {phase === "stageClear" && showChoice && (
            <div style={styles.overlay}>
              <div style={styles.clearCard}>
                <div style={styles.clearTitle}>⭐ STAGE {stage} CLEAR!</div>
                <div style={styles.clearScore}>SCORE: {score}</div>
                <div style={styles.choiceTitle}>パワーアップを選択</div>
                <div style={styles.choiceNote}>選択はブロックチェーンに記録されます</div>
                <div style={styles.choiceGrid}>
                  {[
                    { icon: "❤️", label: "残機+1", sub: "Extra Life", idx: 0 },
                    { icon: "🎱", label: "ボール追加", sub: "Extra Ball", idx: 1 },
                    { icon: "⏱️", label: "+30秒", sub: "Time Extend", idx: 2 },
                  ].map(c => (
                    <button
                      key={c.idx}
                      style={{ ...styles.choiceBtn, opacity: txPending ? 0.6 : 1 }}
                      onClick={() => handleChoice(c.idx)}
                      disabled={txPending}
                    >
                      <div style={styles.choiceIcon}>{c.icon}</div>
                      <div style={styles.choiceLabel}>{c.label}</div>
                      <div style={styles.choiceSub}>{c.sub}</div>
                    </button>
                  ))}
                </div>
                {txMsg && <div style={styles.txMsg}>{txMsg}</div>}
                {txPending && <div style={styles.spinner}>⏳ 処理中...</div>}
              </div>
            </div>
          )}

          {/* Game Over Overlay */}
          {phase === "gameOver" && (
            <div style={styles.overlay}>
              <div style={styles.overCard}>
                <div style={styles.overTitle}>GAME OVER</div>
                <div style={styles.overScore}>SCORE: {score}</div>
                <div style={styles.overStage}>STAGE: {stage}</div>
                {txMsg && <div style={styles.txMsg}>{txMsg}</div>}
                <button
                  style={{ ...styles.submitBtn, opacity: txPending ? 0.6 : 1 }}
                  onClick={submitScore}
                  disabled={txPending || !walletClient}
                >
                  {txPending ? "送信中..." : "⛓️ スコアを記録する"}
                </button>
                <button style={styles.retryBtn} onClick={startGame}>
                  もう一度プレイ
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Side Panel */}
        <div style={styles.sidePanel}>
          <div style={styles.statCard}>
            <div style={styles.statLabel}>STAGE</div>
            <div style={styles.statValue}>{stage}</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statLabel}>SCORE</div>
            <div style={styles.statValue}>{score}</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statLabel}>LIVES</div>
            <div style={styles.statValue}>{"❤️".repeat(Math.max(0, lives))}</div>
          </div>
          <div style={{ ...styles.statCard, ...(timeLeft <= 30 ? styles.danger : {}) }}>
            <div style={styles.statLabel}>TIME</div>
            <div style={styles.statValue}>
              {String(Math.floor(timeLeft / 60)).padStart(2, "0")}:
              {String(timeLeft % 60).padStart(2, "0")}
            </div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statLabel}>BALLS</div>
            <div style={styles.statValue}>{ballCount}</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statLabel}>BLOCKS</div>
            <div style={styles.statValue}>{blocksLeft}</div>
          </div>
          <div style={styles.infoCard}>
            <div style={styles.infoTitle}>⛓️ Base Onchain</div>
            <div style={styles.infoText}>ステージクリア時の選択がBaseブロックチェーンに永久記録されます</div>
          </div>
          <div style={styles.infoCard}>
            <div style={styles.infoTitle}>💣 爆弾ブロック</div>
            <div style={styles.infoText}>破壊すると周囲2×2マスも連鎖破壊！</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = {
  root: {
    minHeight: "100vh",
    background: "linear-gradient(135deg, #f0f4ff 0%, #ffffff 50%, #f0f8ff 100%)",
    fontFamily: "'Courier New', 'Consolas', monospace",
    color: "#1e3a8a",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 24px",
    background: "rgba(255,255,255,0.9)",
    backdropFilter: "blur(12px)",
    borderBottom: "1px solid rgba(37,99,235,0.15)",
    flexWrap: "wrap",
    gap: 8,
  },
  logo: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  logoIcon: { fontSize: 22 },
  logoText: {
    fontSize: 18,
    fontWeight: 900,
    letterSpacing: 3,
    color: "#1d4ed8",
  },
  logoSub: {
    fontSize: 10,
    letterSpacing: 2,
    color: "#60a5fa",
    background: "#eff6ff",
    padding: "2px 6px",
    borderRadius: 4,
  },
  walletBar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  walletAddr: {
    fontSize: 12,
    color: "#2563eb",
    background: "#eff6ff",
    padding: "4px 10px",
    borderRadius: 6,
    border: "1px solid rgba(37,99,235,0.2)",
  },
  disconnectBtn: {
    fontSize: 11,
    padding: "4px 10px",
    background: "transparent",
    border: "1px solid #cbd5e1",
    borderRadius: 6,
    cursor: "pointer",
    color: "#64748b",
  },
  walletPanel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  walletTitle: {
    fontSize: 12,
    color: "#64748b",
  },
  connectorBtn: {
    fontSize: 12,
    padding: "6px 12px",
    background: "#1d4ed8",
    color: "white",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: "inherit",
    fontWeight: 600,
  },
  gameArea: {
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    gap: 20,
    padding: "20px",
    flexWrap: "wrap",
  },
  canvasWrap: {
    position: "relative",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 8px 40px rgba(37,99,235,0.18), 0 2px 8px rgba(0,0,0,0.08)",
    border: "2px solid rgba(37,99,235,0.2)",
  },
  canvas: {
    display: "block",
    maxWidth: "100%",
    cursor: "none",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    background: "rgba(240,244,255,0.92)",
    backdropFilter: "blur(8px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  menuCard: {
    background: "white",
    borderRadius: 16,
    padding: "32px 28px",
    textAlign: "center",
    border: "2px solid rgba(37,99,235,0.2)",
    boxShadow: "0 8px 32px rgba(37,99,235,0.12)",
    maxWidth: 320,
  },
  menuTitle: {
    fontSize: 26,
    fontWeight: 900,
    letterSpacing: 4,
    color: "#1d4ed8",
    marginBottom: 4,
  },
  menuSub: {
    fontSize: 11,
    letterSpacing: 3,
    color: "#60a5fa",
    marginBottom: 20,
  },
  menuRules: {
    textAlign: "left",
    fontSize: 13,
    lineHeight: 2,
    color: "#374151",
    marginBottom: 24,
    background: "#f8faff",
    padding: "12px 16px",
    borderRadius: 8,
  },
  startBtn: {
    width: "100%",
    padding: "14px",
    background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
    color: "white",
    border: "none",
    borderRadius: 10,
    fontSize: 16,
    fontWeight: 900,
    letterSpacing: 3,
    cursor: "pointer",
    fontFamily: "inherit",
    boxShadow: "0 4px 16px rgba(37,99,235,0.4)",
  },
  connectPrompt: {
    color: "#64748b",
    fontSize: 13,
    padding: "12px",
    background: "#f1f5f9",
    borderRadius: 8,
  },
  clearCard: {
    background: "white",
    borderRadius: 16,
    padding: "28px 24px",
    textAlign: "center",
    border: "2px solid rgba(37,99,235,0.2)",
    boxShadow: "0 8px 32px rgba(37,99,235,0.15)",
    maxWidth: 360,
    width: "90%",
  },
  clearTitle: {
    fontSize: 22,
    fontWeight: 900,
    color: "#1d4ed8",
    letterSpacing: 2,
    marginBottom: 4,
  },
  clearScore: {
    fontSize: 14,
    color: "#64748b",
    marginBottom: 16,
  },
  choiceTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "#1e3a8a",
    marginBottom: 4,
  },
  choiceNote: {
    fontSize: 10,
    color: "#93c5fd",
    marginBottom: 14,
  },
  choiceGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 8,
    marginBottom: 12,
  },
  choiceBtn: {
    background: "linear-gradient(135deg, #eff6ff, #dbeafe)",
    border: "2px solid rgba(37,99,235,0.25)",
    borderRadius: 10,
    padding: "12px 6px",
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "all 0.15s",
  },
  choiceIcon: { fontSize: 22, marginBottom: 4 },
  choiceLabel: { fontSize: 11, fontWeight: 700, color: "#1d4ed8" },
  choiceSub: { fontSize: 9, color: "#60a5fa", marginTop: 2 },
  txMsg: {
    fontSize: 12,
    color: "#059669",
    background: "#f0fdf4",
    padding: "8px 12px",
    borderRadius: 6,
    marginTop: 8,
  },
  spinner: {
    fontSize: 12,
    color: "#64748b",
    marginTop: 8,
  },
  overCard: {
    background: "white",
    borderRadius: 16,
    padding: "32px 28px",
    textAlign: "center",
    border: "2px solid rgba(239,68,68,0.3)",
    boxShadow: "0 8px 32px rgba(239,68,68,0.12)",
    maxWidth: 300,
  },
  overTitle: {
    fontSize: 28,
    fontWeight: 900,
    letterSpacing: 4,
    color: "#ef4444",
    marginBottom: 8,
  },
  overScore: {
    fontSize: 18,
    fontWeight: 700,
    color: "#1d4ed8",
    marginBottom: 4,
  },
  overStage: {
    fontSize: 13,
    color: "#64748b",
    marginBottom: 20,
  },
  submitBtn: {
    width: "100%",
    padding: "12px",
    background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
    color: "white",
    border: "none",
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    marginBottom: 10,
    letterSpacing: 1,
  },
  retryBtn: {
    width: "100%",
    padding: "10px",
    background: "transparent",
    color: "#2563eb",
    border: "2px solid rgba(37,99,235,0.3)",
    borderRadius: 10,
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  sidePanel: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    minWidth: 140,
    maxWidth: 160,
  },
  statCard: {
    background: "white",
    border: "1px solid rgba(37,99,235,0.15)",
    borderRadius: 10,
    padding: "10px 14px",
    boxShadow: "0 2px 8px rgba(37,99,235,0.06)",
  },
  danger: {
    borderColor: "rgba(239,68,68,0.4)",
    background: "#fff5f5",
  },
  statLabel: {
    fontSize: 9,
    letterSpacing: 2,
    color: "#93c5fd",
    fontWeight: 700,
    marginBottom: 2,
  },
  statValue: {
    fontSize: 18,
    fontWeight: 900,
    color: "#1d4ed8",
    letterSpacing: 1,
  },
  infoCard: {
    background: "#eff6ff",
    border: "1px solid rgba(37,99,235,0.15)",
    borderRadius: 10,
    padding: "10px 14px",
    marginTop: 4,
  },
  infoTitle: {
    fontSize: 11,
    fontWeight: 700,
    color: "#1d4ed8",
    marginBottom: 4,
  },
  infoText: {
    fontSize: 10,
    color: "#3b82f6",
    lineHeight: 1.5,
  },
};

// ─── Root ────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <Game />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
