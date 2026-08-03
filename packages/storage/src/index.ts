import { randomUUID } from "node:crypto";
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface StorageProvider {
  ensureBucket(): Promise<void>;
  putScreenshot(input: { projectId: string; feedbackId: string; bytes: Buffer; mimeType: string }): Promise<{ key: string }>;
  getObject(key: string): Promise<{ bytes: Uint8Array; contentType?: string }>;
  deleteObject(key: string): Promise<void>;
  health(): Promise<boolean>;
}

export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;
  private serverSideEncryption?: "AES256";

  constructor(options: { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; forcePathStyle?: boolean; serverSideEncryption?: "none" | "AES256" }) {
    this.bucket = options.bucket;
    this.serverSideEncryption = options.serverSideEncryption === "AES256" ? "AES256" : undefined;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle ?? true,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey }
    });
  }

  async ensureBucket(): Promise<void> {
    try { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); }
    catch { await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })); }
  }

  async putScreenshot(input: { projectId: string; feedbackId: string; bytes: Buffer; mimeType: string }): Promise<{ key: string }> {
    const extension = input.mimeType === "image/webp" ? "webp" : "png";
    const key = `projects/${input.projectId}/feedback/${input.feedbackId}/${randomUUID()}.${extension}`;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: input.bytes, ContentType: input.mimeType, ServerSideEncryption: this.serverSideEncryption }));
    return { key };
  }

  async getObject(key: string): Promise<{ bytes: Uint8Array; contentType?: string }> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error("Stored object has no body");
    return { bytes: await result.Body.transformToByteArray(), contentType: result.ContentType };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async health(): Promise<boolean> {
    try { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); return true; }
    catch { return false; }
  }
}
