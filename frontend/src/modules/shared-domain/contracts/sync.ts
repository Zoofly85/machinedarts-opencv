export interface OutboundSyncEvent {
  event_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface SyncQueueContract {
  enqueue: (event: OutboundSyncEvent) => Promise<void>;
  dequeueBatch: (maxItems: number) => Promise<OutboundSyncEvent[]>;
  ack: (eventIds: string[]) => Promise<void>;
  size: () => Promise<number>;
}

