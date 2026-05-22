import React, { createContext, useContext, useEffect, useReducer, useRef, ReactNode } from "react";

export type GameType =
  | "x01"
  | "cricket"
  | "around_the_clock"
  | "target_trainer"
  | "shanghai"
  | "beer_race"
  | "bob27"
  | "bermuda"
  | "one_two_one"
  | "pacman"
  | "playgrounds";

export type InOutMode = "straight" | "double" | "master";

export type CricketVariant = "standard" | "cutthroat" | "no_score" | "triples_only" | "doubles_only";

export interface PlayerConfig {
  name: string;
  isBot: boolean;
  botLevel?: number;
  profileId?: string;
  isPlayerBot?: boolean;
  sourcePlayerId?: string;
  x01Settings?: {
    startScore: number;
    inMode: InOutMode;
    outMode: InOutMode;
  };
}

export interface TeamConfig {
  teamId: number;
  teamName: string;
  playerIndices: number[];
  teamColor: string;
}

export interface LobbyState {
  selectedGame: GameType;
  match: {
    sets: number;
    legs: number;
    freePlay?: boolean;
    bullOff?: boolean;
  };
  startingPlayer?: number;
  players: PlayerConfig[];
  targetTrainer: {
    targetType: "single" | "double" | "treble" | "outer_bull" | "inner_bull";
    targetNumber: number;
    requiredHits: number;
    allowClose: boolean;
    sharedTarget: boolean;
  };
  x01: {
    startScore: number;
    inMode: InOutMode;
    outMode: InOutMode;
    handicapEnabled: boolean;
    gameVariant: "standard" | "last_man_standing" | "team_play";
    lmsTotalLegs: number;
    teams: TeamConfig[];
  };
  cricket: {
    variant: CricketVariant;
  };
  aroundTheClock: {
    mode: "full" | "single" | "double" | "triple";
    order: "1-20-bull" | "20-1-bull" | "random-bull";
    hitsRequired: 1 | 2 | 3;
  };
  beerRace: {
    targetScore: number;
  };
  shanghai: {
    mode: "legs_sets" | "free_play";
    roundRange: "1-10" | "1-20";
  };
  bob27: {
    includeBull: boolean;
    allowNegative: boolean;
  };
  bermuda: {
    mode: "legs_sets" | "free_play";
  };
  oneTwoOne: {
    startingTarget: number;
    targetLimit: number | null;
    failurePolicy: "stay" | "drop" | "reset";
    outRule: "double" | "any";
  };
  pacman: {
    livesPerPlayer: number;
  };
}

export type LobbyAction =
  | { type: "SET_GAME"; game: GameType }
  | { type: "SET_MATCH"; sets: number; legs: number }
  | { type: "SET_FREE_PLAY"; freePlay: boolean }
  | { type: "SET_BULL_OFF"; bullOff: boolean }
  | { type: "SET_STARTING_PLAYER"; startingPlayer: number }
  | { type: "SET_X01"; payload: Partial<LobbyState["x01"]> }
  | { type: "SET_CRICKET"; payload: Partial<LobbyState["cricket"]> }
  | { type: "SET_AROUND_THE_CLOCK"; payload: Partial<LobbyState["aroundTheClock"]> }
  | { type: "SET_TARGET_TRAINER"; payload: Partial<LobbyState["targetTrainer"]> }
  | { type: "SET_BEER_RACE"; payload: Partial<LobbyState["beerRace"]> }
  | { type: "SET_SHANGHAI"; payload: Partial<LobbyState["shanghai"]> }
  | { type: "SET_BOB27"; payload: Partial<LobbyState["bob27"]> }
  | { type: "SET_BERMUDA"; payload: Partial<LobbyState["bermuda"]> }
  | { type: "SET_ONE_TWO_ONE"; payload: Partial<LobbyState["oneTwoOne"]> }
  | { type: "SET_PACMAN"; payload: Partial<LobbyState["pacman"]> }
  | { type: "SET_PLAYERS"; players: PlayerConfig[] }
  | { type: "SET_PLAYER_X01_SETTINGS"; playerIndex: number; settings: PlayerConfig["x01Settings"] }
  | { type: "SET_X01_TEAMS"; teams: TeamConfig[] }
  | { type: "ADD_X01_TEAM"; team: TeamConfig }
  | { type: "REMOVE_X01_TEAM"; teamId: number }
  | { type: "UPDATE_X01_TEAM"; teamId: number; updates: Partial<TeamConfig> }
  | { type: "RESET_STATE"; state: LobbyState };

export const defaultLobbyState: LobbyState = {
  selectedGame: "x01",
  match: {
    sets: 1,
    legs: 3,
    freePlay: false,
    bullOff: false,
  },
  startingPlayer: 0,
  players: [
    { name: "Player 1", isBot: false },
  ],
  targetTrainer: {
    targetType: "treble",
    targetNumber: 20,
    requiredHits: 10,
    allowClose: false,
    sharedTarget: true,
  },
  x01: {
    startScore: 501,
    inMode: "straight",
    outMode: "double",
    handicapEnabled: false,
    gameVariant: "standard",
    lmsTotalLegs: 3,
    teams: [],
  },
  cricket: {
    variant: "standard",
  },
  aroundTheClock: {
    mode: "full",
    order: "1-20-bull",
    hitsRequired: 1,
  },
  beerRace: {
    targetScore: 301,
  },
  shanghai: {
    mode: "legs_sets",
    roundRange: "1-20",
  },
  bob27: {
    includeBull: true,
    allowNegative: true,
  },
  bermuda: {
    mode: "legs_sets",
  },
  oneTwoOne: {
    startingTarget: 121,
    targetLimit: 130,
    failurePolicy: "stay",
    outRule: "double",
  },
  pacman: {
    livesPerPlayer: 5,
  },
};

export function lobbyReducer(state: LobbyState, action: LobbyAction): LobbyState {
  switch (action.type) {
    case "RESET_STATE":
      return action.state;
    case "SET_GAME":
      return { ...state, selectedGame: action.game };
    case "SET_MATCH":
      return { ...state, match: { ...state.match, sets: action.sets, legs: action.legs } };
    case "SET_FREE_PLAY":
      return { ...state, match: { ...state.match, freePlay: action.freePlay } };
    case "SET_BULL_OFF":
      return { ...state, match: { ...state.match, bullOff: action.bullOff } };
    case "SET_STARTING_PLAYER":
      return { ...state, startingPlayer: action.startingPlayer };
    case "SET_X01":
      return { ...state, x01: { ...state.x01, ...action.payload } };
    case "SET_CRICKET":
      return { ...state, cricket: { ...state.cricket, ...action.payload } };
    case "SET_AROUND_THE_CLOCK":
      return { ...state, aroundTheClock: { ...state.aroundTheClock, ...action.payload } };
    case "SET_TARGET_TRAINER":
      return { ...state, targetTrainer: { ...state.targetTrainer, ...action.payload } };
    case "SET_BEER_RACE":
      return { ...state, beerRace: { ...state.beerRace, ...action.payload } };
    case "SET_SHANGHAI":
      return { ...state, shanghai: { ...state.shanghai, ...action.payload } };
    case "SET_BOB27":
      return { ...state, bob27: { ...state.bob27, ...action.payload } };
    case "SET_BERMUDA":
      return { ...state, bermuda: { ...state.bermuda, ...action.payload } };
    case "SET_ONE_TWO_ONE":
      return { ...state, oneTwoOne: { ...state.oneTwoOne, ...action.payload } };
    case "SET_PACMAN":
      return { ...state, pacman: { ...state.pacman, ...action.payload } };
    case "SET_PLAYERS":
      return { ...state, players: action.players };
    case "SET_PLAYER_X01_SETTINGS":
      return {
        ...state,
        players: state.players.map((player, index) =>
          index === action.playerIndex
            ? { ...player, x01Settings: action.settings }
            : player
        ),
      };
    case "SET_X01_TEAMS":
      return {
        ...state,
        x01: { ...state.x01, teams: action.teams },
      };
    case "ADD_X01_TEAM":
      return {
        ...state,
        x01: { ...state.x01, teams: [...state.x01.teams, action.team] },
      };
    case "REMOVE_X01_TEAM":
      return {
        ...state,
        x01: {
          ...state.x01,
          teams: state.x01.teams.filter((t) => t.teamId !== action.teamId),
        },
      };
    case "UPDATE_X01_TEAM":
      return {
        ...state,
        x01: {
          ...state.x01,
          teams: state.x01.teams.map((t) =>
            t.teamId === action.teamId ? { ...t, ...action.updates } : t
          ),
        },
      };
    default:
      return state;
  }
}

const LobbyContext = createContext<{
  state: LobbyState;
  dispatch: React.Dispatch<LobbyAction>;
} | null>(null);

export function LobbyProvider({ children }: { children: ReactNode }) {
  return <LobbyStateProvider>{children}</LobbyStateProvider>;
}

export function LobbyStateProvider({
  children,
  initialState,
  onStateChange,
}: {
  children: ReactNode;
  initialState?: LobbyState;
  onStateChange?: (state: LobbyState) => void;
}) {
  const resolvedInitialState = initialState ?? defaultLobbyState;
  const [state, dispatch] = useReducer(lobbyReducer, resolvedInitialState);
  const lastInitialSnapshotRef = useRef(JSON.stringify(resolvedInitialState));

  useEffect(() => {
    const nextSnapshot = JSON.stringify(resolvedInitialState);
    if (nextSnapshot === lastInitialSnapshotRef.current) {
      return;
    }
    lastInitialSnapshotRef.current = nextSnapshot;
    dispatch({ type: "RESET_STATE", state: resolvedInitialState });
  }, [resolvedInitialState]);

  useEffect(() => {
    onStateChange?.(state);
  }, [onStateChange, state]);

  return (
    <LobbyContext.Provider value={{ state, dispatch }}>
      {children}
    </LobbyContext.Provider>
  );
}

export function useLobby() {
  const context = useContext(LobbyContext);
  if (!context) {
    throw new Error("useLobby must be used within a LobbyProvider");
  }
  return context;
}
