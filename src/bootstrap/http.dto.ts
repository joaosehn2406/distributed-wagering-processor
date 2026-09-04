import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const amountPattern = /^(0|[1-9]\d*)\.\d{2}$/;
const currencyPattern = /^[A-Z]{3}$/;
const wagerKinds = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

export class MoneyDto {
  @IsString()
  @Matches(amountPattern)
  @MaxLength(21)
  amount!: string;

  @IsString()
  @Matches(currencyPattern)
  currency!: string;
}

export class CreateWalletDto {
  @IsUUID('all')
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

export class SubmitWagerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  externalTransactionId!: string;

  @IsUUID('all')
  playerId!: string;

  @IsUUID('all')
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  gameId!: string;

  @IsIn(wagerKinds)
  kind!: (typeof wagerKinds)[number];

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  referenceExternalTransactionId?: string | null;
}

export class WalletIdParamsDto {
  @IsUUID('all')
  walletId!: string;
}

export class TransactionIdParamsDto {
  @IsUUID('all')
  transactionId!: string;
}

export class ProviderTransactionParamsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  externalTransactionId!: string;
}

export class LedgerQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d*$/)
  limit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_024)
  cursor?: string;
}
