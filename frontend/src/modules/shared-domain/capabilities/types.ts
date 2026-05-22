export type AppEdition = "home" | "club";
export type AppRole = "home_user" | "board_kiosk" | "operator";

export type CapabilityMap = {
  can_use_home: boolean;
  can_use_dashboard: boolean;
  can_manage_sessions: boolean;
  can_lock_settings: boolean;
  can_view_club_analytics: boolean;
  can_use_club_board: boolean;
  cloud_sync_enabled: boolean;
};

export type AuthSessionPayload = {
  authenticated: boolean;
  user: {
    id: string;
    name: string;
    role: AppRole;
  };
  entitlements: {
    edition: AppEdition;
    venue_id: string;
    board_id: string;
    capabilities: CapabilityMap;
  };
  board_context: {
    venue_id: string;
    board_id: string;
    role: AppRole;
  };
};

