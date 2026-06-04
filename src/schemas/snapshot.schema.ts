import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ApiProperty } from '@nestjs/swagger';

export enum SnapshotStatus {
  CREATING = 'creating',
  READY = 'ready',
  RESTORING = 'restoring',
  FAILED = 'failed',
}

@Schema({ timestamps: true, collection: 'snapshots' })
export class Snapshot {
  @ApiProperty()
  @Prop({ required: true, unique: true, index: true })
  snapshotId: string;

  @ApiProperty()
  @Prop({ required: true, index: true })
  sandboxId: string;

  @ApiProperty()
  @Prop({ required: true })
  name: string;

  @ApiProperty()
  @Prop()
  description: string;

  @ApiProperty({ enum: SnapshotStatus })
  @Prop({ default: SnapshotStatus.CREATING, enum: SnapshotStatus })
  status: SnapshotStatus;

  @ApiProperty()
  @Prop({ required: true })
  image: string;

  @ApiProperty()
  @Prop({ required: true })
  workdir: string;

  @ApiProperty()
  @Prop({ default: 1 })
  cpus: number;

  @ApiProperty()
  @Prop({ default: 256 })
  memoryMib: number;

  @ApiProperty()
  @Prop({ type: Object, default: {} })
  envVars: Record<string, string>;

  @ApiProperty()
  @Prop({ type: Object, default: {} })
  ports: Record<string, number>;

  @ApiProperty()
  @Prop({ required: true })
  snapshotPath: string;

  @ApiProperty({
    description:
      "What the tarball captures: 'full' (whole-filesystem diff vs base image) " +
      "or 'workdir' (working directory only). New snapshots set this explicitly " +
      "at create time; the default is 'workdir' so legacy documents that predate " +
      'this field hydrate as workdir-only (their tarball is a workdir archive) ' +
      'and restore correctly.',
  })
  @Prop({ default: 'workdir' })
  scope: string;

  @ApiProperty({
    description:
      "Compression codec of the tarball: 'zstd' or 'gzip'. Recorded at create " +
      'time so restore decompresses with the matching tool.',
  })
  @Prop({ default: 'gzip' })
  compression: string;

  @ApiProperty()
  @Prop({ default: 0 })
  sizeBytes: number;

  @ApiProperty()
  @Prop({ type: Object, default: {} })
  metadata: Record<string, any>;
}

export type SnapshotDocument = Snapshot & Document;
export const SnapshotSchema = SchemaFactory.createForClass(Snapshot);
