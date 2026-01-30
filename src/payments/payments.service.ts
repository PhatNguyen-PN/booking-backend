import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { NotificationsService } from 'src/notifications/notifications.service'; // 👈 Import Service này

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService // 👈 Inject vào đây
  ) { }

  // 1. Tạo thanh toán
  async create(createPaymentDto: CreatePaymentDto, userId: number) {
    const { bookingId, provider } = createPaymentDto;

    console.log('Payment attempt:', { bookingId, provider, userId });

    // A. Kiểm tra Booking
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    console.log('Booking found:', booking);

    if (!booking) throw new NotFoundException('Đơn đặt phòng không tồn tại');
    if (booking.guestId !== userId) {
      console.log('Permission denied:', { bookingGuestId: booking.guestId, userId });
      throw new BadRequestException('Bạn không có quyền thanh toán đơn này');
    }
    if (booking.status === 'CANCELLED') throw new BadRequestException('Đơn này đã bị hủy, không thể thanh toán');

    // Cho phép thanh toán lại nếu đã CONFIRMED (có thể là thanh toán bổ sung)
    if (booking.status === 'CONFIRMED') {
      console.log('Booking already confirmed, allowing re-payment');
    }

    // B. Lưu thông tin thanh toán
    const payment = await this.prisma.payment.create({
      data: {
        bookingId,
        amount: booking.totalPrice,
        provider,
        status: 'PENDING', // Thay đổi: bắt đầu với PENDING, chờ Host xác nhận
        transactionCode: `TRANS_${Date.now()}`,
      },
    });

    // C. Cập nhật trạng thái Booking -> CONFIRMED
    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'CONFIRMED' },
    });

    // 👇 D. BẮN THÔNG BÁO (ĐOẠN CODE BẠN YÊU CẦU) 👇

    // 1. Thông báo cho Khách (Guest)
    await this.notificationsService.create({
      userId: booking.guestId,
      title: 'Thanh toán thành công',
      message: `Đơn đặt phòng #${booking.id} của bạn đã được xác nhận!`,
      type: 'PAYMENT'
    });

    // 2. Thông báo cho Chủ nhà (Host)
    // Cần tìm xem ai là chủ của cái property này
    const property = await this.prisma.properties.findUnique({
      where: { id: booking.propertyId }
    });

    if (property) {
      await this.notificationsService.create({
        userId: property.ownerId,
        title: 'Bạn có đơn đặt phòng mới',
        message: `Khách đã thanh toán cho đơn #${booking.id}. Chuẩn bị đón khách nhé!`,
        type: 'BOOKING'
      });
    }

    return payment;
  }

  // 2. Lấy lịch sử thanh toán của 1 booking
  async findOneByBooking(bookingId: number) {
    return this.prisma.payment.findUnique({
      where: { bookingId },
    });
  }

  // 3. Lấy lịch sử thanh toán của user
  async findMyPayments(userId: number) {
    return this.prisma.payment.findMany({
      where: {
        booking: {
          guestId: userId,
        },
      },
      include: {
        booking: {
          include: {
            property: { select: { title: true, address: true } },
          },
        },
      },
      orderBy: { paymentDate: 'desc' },
    });
  }

  // 4. Lấy payments PENDING cho Host xác nhận
  async findPendingPaymentsForHost(hostId: number) {
    return this.prisma.payment.findMany({
      where: {
        status: 'PENDING',
        booking: {
          property: {
            ownerId: hostId,
          },
        },
      },
      include: {
        booking: {
          include: {
            guest: { select: { fullName: true, email: true } },
            property: { select: { title: true, address: true } },
          },
        },
      },
      orderBy: { paymentDate: 'desc' },
    });
  }

  // 5. Host cập nhật trạng thái payment
  async updatePaymentStatus(paymentId: number, status: 'SUCCESS' | 'FAILED' | 'REFUNDED', hostId: number) {
    // Kiểm tra quyền: chỉ Host của property mới được update
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        booking: {
          include: {
            property: true,
          },
        },
      },
    });

    if (!payment) throw new NotFoundException('Payment không tồn tại');
    if (payment.booking.property.ownerId !== hostId) {
      throw new BadRequestException('Bạn không có quyền cập nhật payment này');
    }
    if (payment.status !== 'PENDING') {
      throw new BadRequestException('Payment này đã được xử lý');
    }

    // Update payment status
    const updatedPayment = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status },
    });

    // Update booking status tương ứng
    let bookingStatus: 'CONFIRMED' | 'CANCELLED' | 'REFUNDED' | undefined;
    if (status === 'SUCCESS') {
      bookingStatus = 'CONFIRMED';
    } else if (status === 'FAILED') {
      bookingStatus = 'CANCELLED';
    } else if (status === 'REFUNDED') {
      bookingStatus = 'REFUNDED';
    }

    if (bookingStatus) {
      await this.prisma.booking.update({
        where: { id: payment.bookingId },
        data: { status: bookingStatus },
      });
    }

    // Gửi notification cho Guest
    let notificationTitle: string = '';
    let notificationMessage: string = '';

    if (status === 'SUCCESS') {
      notificationTitle = 'Thanh toán đã được xác nhận';
      notificationMessage = `Thanh toán cho đơn #${payment.bookingId} đã được xác nhận thành công!`;
    } else if (status === 'FAILED') {
      notificationTitle = 'Thanh toán thất bại';
      notificationMessage = `Thanh toán cho đơn #${payment.bookingId} đã bị từ chối.`;
    } else if (status === 'REFUNDED') {
      notificationTitle = 'Hoàn tiền thành công';
      notificationMessage = `Đã hoàn tiền cho đơn #${payment.bookingId}.`;
    }

    await this.notificationsService.create({
      userId: payment.booking.guestId,
      title: notificationTitle,
      message: notificationMessage,
      type: 'PAYMENT',
    });

    return updatedPayment;
  }

  async findAllAdmin() {
    return this.prisma.payment.findMany({
      include: {
        booking: {
          include: {
            guest: { select: { fullName: true, email: true } },
            property: { select: { title: true } },
          },
        },
      },
      orderBy: { paymentDate: 'desc' },
    });
  }

}