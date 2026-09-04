import { Entity, PrimaryKey } from '@mikro-orm/core';

/** Infrastructure-only MikroORM mapping; financial domain types remain persistence-independent. */
@Entity({ tableName: 'schema_migrations' })
export class SchemaMigrationEntity {
  @PrimaryKey({ type: 'string' })
  name!: string;
}
