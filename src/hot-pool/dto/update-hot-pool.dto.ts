import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Partial update of the hot pool runtime configuration. Any field omitted
 * keeps its current persisted value.
 */
export class UpdateHotPoolDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Snapshot ID used as the source for every hot sandbox.',
  })
  @IsOptional()
  @IsString()
  snapshotId?: string;

  @ApiPropertyOptional({
    description: 'Percentage (0–100) of total memory cap reserved for the pool.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  memoryReservePercent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(64)
  @Max(32 * 1024)
  memoryMibPerSandbox?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(32)
  cpus?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  minSize?: number;

  @ApiPropertyOptional({
    description:
      'Optional safety ceiling for the pool. Pass `null` to clear and let `memoryReservePercent` × `memoryMibPerSandbox` be the only cap.',
    type: Number,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(1000)
  maxSize?: number | null;

  @ApiPropertyOptional({
    description:
      'Fixed pool size override. When set, sizing ignores the percentage.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  targetSize?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(10 * 60 * 1000)
  reconcileIntervalMs?: number;
}
