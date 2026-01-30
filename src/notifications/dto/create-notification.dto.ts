import { IsNotEmpty, IsNumber, IsString, IsOptional } from 'class-validator';

export class CreateNotificationDto {
  @IsNotEmpty()
  @IsNumber()
  userId: number; // Người nhận

  @IsOptional()
  @IsNumber()
  senderId?: number; // Người gửi (optional, dùng cho Admin gửi thông báo)

  @IsNotEmpty()
  @IsString()
  title: string;

  @IsNotEmpty()
  @IsString()
  message: string;

  @IsNotEmpty()
  @IsString()
  type: string; // 'SYSTEM', 'BOOKING', 'PAYMENT'
}