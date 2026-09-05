import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

@Injectable()
export class DatabaseService {
  constructor(public readonly em: EntityManager) {}
  async transaction<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.em.transactional(work);
  }
}
