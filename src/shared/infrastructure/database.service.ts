import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { InjectEntityManager } from '@mikro-orm/nestjs';

@Injectable()
export class DatabaseService {
  constructor(@InjectEntityManager('default') public readonly em: EntityManager) {}
  async transaction<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.em.transactional(work);
  }
}
