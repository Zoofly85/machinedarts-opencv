class LoopbackPeer {
  constructor(name) {
    this.name = name;
    this.remote = null;
    this.closed = false;
    this.messages = [];
  }

  connect(remote) {
    this.remote = remote;
  }

  send(message) {
    if (this.closed || !this.remote || this.remote.closed) {
      return false;
    }
    const payload = structuredClone(message);
    this.messages.push({ direction: "out", payload });
    queueMicrotask(() => {
      if (this.closed || !this.remote || this.remote.closed) {
        return;
      }
      this.remote.messages.push({ direction: "in", payload });
    });
    return true;
  }

  close() {
    this.closed = true;
  }

  incoming() {
    return this.messages.filter((entry) => entry.direction === "in").map((entry) => entry.payload);
  }
}

function createPair() {
  const host = new LoopbackPeer("host");
  const joiner = new LoopbackPeer("joiner");
  host.connect(joiner);
  joiner.connect(host);
  return { host, joiner };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function brief(message) {
  if (message.type === "turn_owner") {
    return `turn_owner -> ${message.currentPlayerId}`;
  }
  if (message.type === "fronton_snapshot") {
    return `fronton_snapshot t${message.turnIndex} d${message.dartIndex}`;
  }
  if (message.type === "dart_score") {
    return `dart_score t${message.turnIndex} d${message.dartIndex} ${message.appliedScore}`;
  }
  if (message.type === "turn_commit") {
    return `turn_commit t${message.turnIndex} -> ${message.currentPlayerId}`;
  }
  if (message.type === "match_complete") {
    return "match_complete";
  }
  return message.type;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function sendScenario(sender, receiver, label, messages) {
  for (const message of messages) {
    assert(sender.send(message), `${label}: failed to send ${brief(message)}`);
  }
  await flushMicrotasks();

  const incoming = receiver.incoming();
  assert(incoming.length === messages.length, `${label}: expected ${messages.length} messages, got ${incoming.length}`);
  messages.forEach((message, index) => {
    assert(incoming[index].type === message.type, `${label}: message ${index + 1} expected ${message.type}, got ${incoming[index].type}`);
  });

  return incoming;
}

function buildMatchSummary({ winnerIndex, hostId, joinerId, hostScore, joinerScore, hostLegsWon, joinerLegsWon, hostSetsWon, joinerSetsWon, currentSet, currentLeg }) {
  return {
    settings: {
      startScore: 501,
      inMode: "straight",
      outMode: "double",
      legsPerSet: 3,
      setsToWin: 2,
      freePlay: false,
    },
    match: {
      currentSet,
      currentLeg,
      legWinner: winnerIndex,
      setWinner: winnerIndex,
      matchWinner: winnerIndex,
    },
    currentPlayer: null,
    players: [
      {
        name: "Host",
        score: hostScore,
        startingScore: 501,
        hasIn: true,
        inMode: "straight",
        outMode: "double",
        dartsThrown: 18,
        totalScored: 432,
        average: 72,
        firstNineAverage: 90,
        legsWon: hostLegsWon,
        setsWon: hostSetsWon,
      },
      {
        name: "Joiner",
        score: joinerScore,
        startingScore: 501,
        hasIn: true,
        inMode: "straight",
        outMode: "double",
        dartsThrown: 21,
        totalScored: 501,
        average: 71.57,
        firstNineAverage: 84,
        legsWon: joinerLegsWon,
        setsWon: joinerSetsWon,
      },
    ],
    currentTurn: {
      darts: [null, null, null],
      appliedScores: [0, 0, 0],
      scored: 0,
      remaining: 501,
      bust: false,
      finished: false,
      dartsUsed: 0,
      scoreBefore: 501,
      hasInBefore: true,
      hasInAfter: true,
      turnIndex: currentLeg,
    },
    lastTurn: {
      playerIndex: winnerIndex,
      turnIndex: currentLeg,
      darts: [
        { score: 60, multiplier: 3, segment: "20", zone: "triple", confidence: 1 },
        { score: 57, multiplier: 3, segment: "19", zone: "triple", confidence: 1 },
        { score: 24, multiplier: 2, segment: "12", zone: "double", confidence: 1 },
      ],
      appliedScores: [60, 57, 24],
      scored: 141,
      remaining: 0,
      bust: false,
      finished: true,
      dartsUsed: 3,
      scoreBefore: 141,
      hasInBefore: true,
      hasInAfter: true,
    },
    winner: winnerIndex,
    matchWinner: winnerIndex,
    hostId,
    joinerId,
  };
}

async function main() {
  const { host, joiner } = createPair();

  const hostId = "host-player";
  const joinerId = "joiner-player";

  const hostTurn = [
    { type: "turn_owner", playerId: hostId, currentPlayerId: hostId, turnIndex: 1 },
    { type: "fronton_snapshot", playerId: hostId, turnIndex: 1, dartIndex: 0, remaining: 501, imageDataUrl: "empty-host" },
    {
      type: "dart_score",
      playerId: hostId,
      turnIndex: 1,
      dartIndex: 1,
      remaining: 481,
      appliedScore: 20,
      dart: { score: 20, multiplier: 1, segment: "20", zone: "single_inner", confidence: 1 },
      imageDataUrl: "host-d1",
    },
    {
      type: "dart_score",
      playerId: hostId,
      turnIndex: 1,
      dartIndex: 2,
      remaining: 421,
      appliedScore: 60,
      dart: { score: 60, multiplier: 3, segment: "20", zone: "triple", confidence: 1 },
      imageDataUrl: "host-d2",
    },
    {
      type: "dart_score",
      playerId: hostId,
      turnIndex: 1,
      dartIndex: 3,
      remaining: 381,
      appliedScore: 40,
      dart: { score: 40, multiplier: 2, segment: "20", zone: "double", confidence: 1 },
      imageDataUrl: "host-d3",
    },
    {
      type: "turn_commit",
      playerId: hostId,
      turnIndex: 1,
      currentPlayerId: joinerId,
      remaining: 381,
      totalScored: 120,
      dartsThrown: 3,
      average: 120,
      legsWon: 0,
      setsWon: 0,
      players: [
        { playerId: hostId, score: 381, totalScored: 120, dartsThrown: 3, average: 120, legsWon: 0, setsWon: 0 },
        { playerId: joinerId, score: 501, totalScored: 0, dartsThrown: 0, average: 0, legsWon: 0, setsWon: 0 },
      ],
      darts: [
        { score: 20, multiplier: 1, segment: "20", zone: "single_inner", confidence: 1 },
        { score: 60, multiplier: 3, segment: "20", zone: "triple", confidence: 1 },
        { score: 40, multiplier: 2, segment: "20", zone: "double", confidence: 1 },
      ],
      appliedScores: [20, 60, 40],
    },
    { type: "turn_owner", playerId: hostId, currentPlayerId: joinerId, turnIndex: 1 },
  ];

  const joinerIncoming = await sendScenario(host, joiner, "host turn", hostTurn);

  const joinerTurn = [
    { type: "fronton_snapshot", playerId: joinerId, turnIndex: 1, dartIndex: 0, remaining: 501, imageDataUrl: "empty-joiner" },
    {
      type: "dart_score",
      playerId: joinerId,
      turnIndex: 1,
      dartIndex: 1,
      remaining: 441,
      appliedScore: 60,
      dart: { score: 60, multiplier: 3, segment: "20", zone: "triple", confidence: 1 },
      imageDataUrl: "joiner-d1",
    },
    {
      type: "dart_score",
      playerId: joinerId,
      turnIndex: 1,
      dartIndex: 2,
      remaining: 401,
      appliedScore: 40,
      dart: { score: 40, multiplier: 2, segment: "20", zone: "double", confidence: 1 },
      imageDataUrl: "joiner-d2",
    },
    {
      type: "dart_score",
      playerId: joinerId,
      turnIndex: 1,
      dartIndex: 3,
      remaining: 381,
      appliedScore: 20,
      dart: { score: 20, multiplier: 1, segment: "20", zone: "single_inner", confidence: 1 },
      imageDataUrl: "joiner-d3",
    },
    {
      type: "turn_commit",
      playerId: joinerId,
      turnIndex: 1,
      currentPlayerId: hostId,
      remaining: 381,
      totalScored: 120,
      dartsThrown: 3,
      average: 120,
      legsWon: 0,
      setsWon: 0,
      players: [
        { playerId: hostId, score: 381, totalScored: 120, dartsThrown: 3, average: 120, legsWon: 0, setsWon: 0 },
        { playerId: joinerId, score: 381, totalScored: 120, dartsThrown: 3, average: 120, legsWon: 0, setsWon: 0 },
      ],
      darts: [
        { score: 60, multiplier: 3, segment: "20", zone: "triple", confidence: 1 },
        { score: 40, multiplier: 2, segment: "20", zone: "double", confidence: 1 },
        { score: 20, multiplier: 1, segment: "20", zone: "single_inner", confidence: 1 },
      ],
      appliedScores: [60, 40, 20],
    },
    { type: "turn_owner", playerId: joinerId, currentPlayerId: hostId, turnIndex: 1 },
  ];

  const hostIncoming = await sendScenario(joiner, host, "joiner turn", joinerTurn);

  const { host: legWinnerSender, joiner: legWinnerReceiver } = createPair();
  const legWinMessages = [
    {
      type: "turn_commit",
      playerId: joinerId,
      turnIndex: 9,
      currentPlayerId: hostId,
      remaining: 0,
      totalScored: 141,
      dartsThrown: 18,
      average: 83.5,
      legsWon: 1,
      setsWon: 0,
      players: [
        { playerId: hostId, score: 501, totalScored: 432, dartsThrown: 18, average: 72, legsWon: 0, setsWon: 0 },
        { playerId: joinerId, score: 501, totalScored: 501, dartsThrown: 21, average: 71.57, legsWon: 1, setsWon: 0 },
      ],
      darts: [
        { score: 60, multiplier: 3, segment: "20", zone: "triple", confidence: 1 },
        { score: 57, multiplier: 3, segment: "19", zone: "triple", confidence: 1 },
        { score: 24, multiplier: 2, segment: "12", zone: "double", confidence: 1 },
      ],
      appliedScores: [60, 57, 24],
    },
    { type: "turn_owner", playerId: joinerId, currentPlayerId: hostId, turnIndex: 1 },
    { type: "fronton_snapshot", playerId: hostId, turnIndex: 1, dartIndex: 0, remaining: 501, imageDataUrl: "empty-host-leg-2" },
  ];
  const legWinIncoming = await sendScenario(legWinnerSender, legWinnerReceiver, "leg win reset", legWinMessages);
  const legCommit = legWinIncoming.find((message) => message.type === "turn_commit");
  assert(legCommit, "leg win reset: missing turn_commit");
  assert(legCommit.players[0].score === 501 && legCommit.players[1].score === 501, "leg win reset: both player scores should reset to 501");
  assert(legCommit.players[1].legsWon === 1 && legCommit.players[1].setsWon === 0, "leg win reset: winner legs/sets should be 1/0");
  assert(legCommit.currentPlayerId === hostId, "leg win reset: next turn should pass to host");

  const { host: setWinnerSender, joiner: setWinnerReceiver } = createPair();
  const setWinMessages = [
    {
      type: "turn_commit",
      playerId: hostId,
      turnIndex: 15,
      currentPlayerId: joinerId,
      remaining: 0,
      totalScored: 100,
      dartsThrown: 24,
      average: 75,
      legsWon: 0,
      setsWon: 1,
      players: [
        { playerId: hostId, score: 501, totalScored: 501, dartsThrown: 24, average: 75, legsWon: 0, setsWon: 1 },
        { playerId: joinerId, score: 501, totalScored: 462, dartsThrown: 24, average: 69.3, legsWon: 0, setsWon: 0 },
      ],
      darts: [
        { score: 60, multiplier: 3, segment: "20", zone: "triple", confidence: 1 },
        { score: 20, multiplier: 1, segment: "20", zone: "single_inner", confidence: 1 },
        { score: 20, multiplier: 1, segment: "20", zone: "single_inner", confidence: 1 },
      ],
      appliedScores: [60, 20, 20],
    },
    { type: "turn_owner", playerId: hostId, currentPlayerId: joinerId, turnIndex: 1 },
    { type: "fronton_snapshot", playerId: joinerId, turnIndex: 1, dartIndex: 0, remaining: 501, imageDataUrl: "empty-joiner-set-2" },
  ];
  const setWinIncoming = await sendScenario(setWinnerSender, setWinnerReceiver, "set win reset", setWinMessages);
  const setCommit = setWinIncoming.find((message) => message.type === "turn_commit");
  assert(setCommit, "set win reset: missing turn_commit");
  assert(setCommit.players[0].score === 501 && setCommit.players[1].score === 501, "set win reset: both player scores should reset to 501");
  assert(setCommit.players[0].legsWon === 0 && setCommit.players[1].legsWon === 0, "set win reset: legs should reset for a new set");
  assert(setCommit.players[0].setsWon === 1, "set win reset: host sets won should increment");
  assert(setCommit.currentPlayerId === joinerId, "set win reset: next turn should pass to joiner");

  const { host: matchCompleteSender, joiner: matchCompleteReceiver } = createPair();
  const matchCompleteSummary = buildMatchSummary({
    winnerIndex: 1,
    hostId,
    joinerId,
    hostScore: 417,
    joinerScore: 0,
    hostLegsWon: 1,
    joinerLegsWon: 2,
    hostSetsWon: 0,
    joinerSetsWon: 2,
    currentSet: 2,
    currentLeg: 3,
  });
  const matchCompleteMessages = [
    {
      type: "match_complete",
      playerId: joinerId,
      summary: matchCompleteSummary,
    },
  ];
  const matchCompleteIncoming = await sendScenario(matchCompleteSender, matchCompleteReceiver, "match complete", matchCompleteMessages);
  const matchComplete = matchCompleteIncoming[0];
  assert(matchComplete.type === "match_complete", "match complete: expected match_complete message");
  assert(matchComplete.summary.match.matchWinner === 1, "match complete: summary should include match winner");
  assert(matchComplete.summary.players[1].setsWon === 2, "match complete: winner set count should be present for stats page");
  assert(matchComplete.summary.players[0].name === "Host" && matchComplete.summary.players[1].name === "Joiner", "match complete: summary should include player names");

  console.log("Online peer flow smoke test passed.");
  console.log("Host -> Joiner:", hostTurn.map(brief).join(" | "));
  console.log("Joiner -> Host:", joinerTurn.map(brief).join(" | "));
  console.log("Leg win reset:", legWinMessages.map(brief).join(" | "));
  console.log("Set win reset:", setWinMessages.map(brief).join(" | "));
  console.log("Match complete:", matchCompleteMessages.map(brief).join(" | "));
}

main().catch((error) => {
  console.error("Online peer flow smoke test failed.");
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
