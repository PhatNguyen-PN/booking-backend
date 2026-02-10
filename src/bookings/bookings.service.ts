import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { NotificationsService } from 'src/notifications/notifications.service'; 

@Injectable()
export class BookingsService {
  constructor(
    private prisma: PrismaService,
    private readonly notificationsService: NotificationsService 
  ) {}

  // Đếm tổng booking
  async countAll() {
    return this.prisma.booking.count();
  }

  // Tổng doanh thu (booking hoàn thành)
  async sumRevenue() {
    const result = await this.prisma.booking.aggregate({
      _sum: { totalPrice: true },
      where: { status: 'COMPLETED' },
    });
    return result._sum.totalPrice || 0;
  }

  // ADMIN: lấy toàn bộ booking
  async findAll() {
    return this.prisma.booking.findMany({
      include: {
        guest: { select: { fullName: true, email: true } },
        property: { select: { title: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // --- HÀM TẠO BOOKING ---
  async create(userId: number, dto: CreateBookingDto) {
    const { propertyId, checkIn, checkOut } = dto;

    const startDate = new Date(checkIn);
    const endDate = new Date(checkOut);

    const now = new Date();
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);

    if (startDate < now) {
      throw new BadRequestException('Ngày check-in không được ở trong quá khứ');
    }
    if (startDate >= endDate) {
      throw new BadRequestException('Ngày check-out phải sau ngày check-in');
    }

    const property = await this.prisma.properties.findUnique({
      where: { id: propertyId },
    });
    if (!property) throw new NotFoundException('Phòng không tồn tại');

    // Kiểm tra trùng lịch
    const conflictingBooking = await this.prisma.booking.findFirst({
      where: {
        propertyId,
        status: { not: 'CANCELLED' },
        AND: [
          { checkIn: { lt: endDate } },
          { checkOut: { gt: startDate } },
        ],
      },
    });

    if (conflictingBooking) {
      throw new BadRequestException('Phòng đã kín lịch trong khoảng thời gian này!');
    }

    // Tính tiền
    const oneDay = 24 * 60 * 60 * 1000;
    const diffDays = Math.round(
      Math.abs((endDate.getTime() - startDate.getTime()) / oneDay),
    );
    const totalPrice = Number(property.pricePerNight) * diffDays;

    // 1. TẠO BOOKING
    const newBooking = await this.prisma.booking.create({
      data: {
        checkIn: startDate,
        checkOut: endDate,
        totalPrice,
        guestId: userId,
        propertyId,
        status: 'CONFIRMED',
        nightlyPrice: property.pricePerNight,
        cleaningFee: property.cleaningFee || 0,
        serviceFee: 0,
      },
      include: {
        guest: true,
        property: true
      }
    });

    // 2. GỌI SERVICE THÔNG BÁO
    try {
      const guestName = newBooking.guest?.fullName || 'Khách hàng';
      const propertyTitle = newBooking.property?.title || 'Phòng';

      await this.notificationsService.create({
        title: 'Đơn đặt phòng mới! 🚀',
        message: `${guestName} vừa đặt thành công: ${propertyTitle}. Tổng tiền: ${totalPrice.toLocaleString('vi-VN')}đ`,
        type: 'BOOKING',
      });
    } catch (error) {
      console.error("Lỗi khi gửi thông báo:", error); 
    }

    return newBooking;
  }

  async getMyBookings(userId: number) {
    return this.prisma.booking.findMany({
      where: { guestId: userId },
      include: { property: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // --- HÀM CANCEL (ĐÃ SỬA LỖI) ---
  async cancel(bookingId: number, userId: number) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) throw new NotFoundException('Không tìm thấy đơn đặt phòng');
    
    if (booking.guestId !== userId) {
      throw new BadRequestException('Bạn không có quyền hủy đơn đặt phòng này');
    } 
    // Đã xóa chữ 'khách' bị thừa ở đây

    if (booking.status === 'CANCELLED') {
      throw new BadRequestException('Đơn này đã được hủy trước đó');
    }
    if (booking.status === 'COMPLETED') {
      throw new BadRequestException('Chuyến đi đã kết thúc, không thể hủy');
    }

    return this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'CANCELLED' },
    });
  }
}