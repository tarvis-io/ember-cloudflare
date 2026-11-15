export interface WorkshopState {
  id: string;
  name: string;
  enabled: boolean;
  discussionEnabled: boolean;
  revision: number;
  announcement: { id: string; text: string; author: string; createdAt: string } | null;
}
export type WorkshopServerFrame = { type: "workshop.state"; state: WorkshopState };
