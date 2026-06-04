import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn } from 'class-validator';

export type SnapshotScope = 'full' | 'workdir';

export class CreateSnapshotDto {
  @ApiProperty({ description: 'ID of the sandbox to snapshot' })
  @IsString()
  sandboxId: string;

  @ApiPropertyOptional({ description: 'Snapshot name' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Snapshot description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description:
      "What the snapshot captures. 'full' (default): the whole filesystem diff " +
      'vs the base image — installed packages (apt/npm-g/pip), /usr/local/bin ' +
      "binaries and /etc configs survive a restore. 'workdir': only the working " +
      'directory (lighter, legacy behaviour).',
    enum: ['full', 'workdir'],
  })
  @IsOptional()
  @IsIn(['full', 'workdir'])
  scope?: SnapshotScope;
}
