export interface InboxStore {
  claim(eventId: string, eventType: string): Promise<boolean>;
  release(eventId: string): Promise<void>;
}

export class IdempotentConsumer {
  constructor(private readonly inbox: InboxStore) {}

  async handle(eventId: string, eventType: string, handler: () => Promise<void>): Promise<'PROCESSED' | 'DUPLICATE'> {
    if (!(await this.inbox.claim(eventId, eventType))) return 'DUPLICATE';
    try {
      await handler();
      return 'PROCESSED';
    } catch (error) {
      await this.inbox.release(eventId);
      throw error;
    }
  }
}
