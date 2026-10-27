import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { SegmentsService } from '../segments/segments.service';
import { ChannelClientService } from '../channel-client/channel-client.service';
import { buildPagination, paginatedResult } from '../../common/helpers/pagination.helper';

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly segmentsService: SegmentsService,
    private readonly channelClientService: ChannelClientService,
  ) {}

  async create(createCampaignDto: CreateCampaignDto) {
    await this.segmentsService.findOne(createCampaignDto.segmentId);

    return this.prisma.campaign.create({
      data: {
        name: createCampaignDto.name,
        objective: createCampaignDto.objective,
        segmentId: createCampaignDto.segmentId,
        messageTemplate: createCampaignDto.messageTemplate,
        channel: createCampaignDto.channel,
        status: 'draft',
      },
    });
  }

  async findAll(query?: { page?: string; limit?: string; search?: string }) {
    const pagination = buildPagination(query);

    const where: any = {};
    if (query?.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    const [data, total] = await Promise.all([
      this.prisma.campaign.findMany({
        skip: pagination.skip,
        take: pagination.limit,
        where,
        include: {
          segment: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.campaign.count({ where }),
    ]);

    return paginatedResult(data, total, pagination);
  }

  async findOne(id: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      include: {
        segment: true,
      },
    });
    if (!campaign) {
      throw new NotFoundException(`Campaign with ID ${id} not found`);
    }
    return campaign;
  }

  async approve(id: string) {
    const campaign = await this.findOne(id);
    if (campaign.status !== 'draft') {
      throw new BadRequestException(`Campaign status is already ${campaign.status}, cannot approve`);
    }
    return this.prisma.campaign.update({
      where: { id },
      data: { status: 'approved' },
    });
  }

  async send(id: string) {
    const campaign = await this.findOne(id);
    if (campaign.status !== 'approved') {
      throw new BadRequestException(
        `Campaign status is ${campaign.status}. Campaigns must be approved before sending.`,
      );
    }

    // Evaluate segment matching customers
    const previewResult = await this.segmentsService.preview(campaign.segmentId);
    const targetCustomers = previewResult.customers;

    if (targetCustomers.length === 0) {
      throw new BadRequestException('Target segment has 0 matching customers. Cannot send campaign.');
    }


    //Mark the campign 
    await this.prisma.campaign.update({
      where: {id},
      data : {status: 'dispatching'}
    });

    const existingSucessess = await this.prisma.communication.findMany({
      where: {
        campaignId : id,
        status : 'sent'
      },
      select: {customerId : true}
    });

    const successfullCustomerIds = new Set(existingSucessess.map(c => c.customerId));
    let successCount = 0;
    let failureCount = 0;

    for(const customer of targetCustomers) {
      if(successfullCustomerIds.has(customer.id)) {
        successCount++;
        continue;
      }

       const messageRendered = campaign.messageTemplate
        .replace(/\{\{name\}\}/g, customer.name)
        .replace(/\{\{email\}\}/g, customer.email);


        const communication = await this.prisma.communication.upsert({
        where: {
          campaignId_customerId: {
            campaignId: id,
            customerId: customer.id,
          },
        },
        create: {
          campaignId: id,
          customerId: customer.id,
          channel: campaign.channel,
          messageRendered,
          status: 'pending',
        },
        update: {
          status: 'pending',
          messageRendered,
          failureReason: null,
          sentAt: null,
          deliveredAt: null,
          openedAt: null,
          clickedAt: null,
          purchasedAt: null,
        },
      });

      try {
        await this.channelClientService.send({
          communicationId: communication.id,
          campaignId : id,
          customer: {
            id: customer.id,
            name: customer.name,
            phone: customer.phone,
            email: customer.email,
          },
          channel: campaign.channel,
          message: messageRendered,
        });
        await this.primsa.communication.update({
          where: {id: communication.id},
          data: {status: 'sent', sentAt: new Date()},

        });
        successCount++;
      } catch(error) {
        await this.primsa.communication.update({
          where : { id : communication.id},
          data: {
            status: 'failed',
            failureReason: error instanceof Error ? error.message : 'Unknown Dispatch Error'
          },
        });
        failureCount++;
      }
    } 


    let finalStatus = 'sent';
    if(failureCount > 0) {
      finalStatus = successCount == 0? 'failed' : 'partial';
    }

    const updatedCampaign = await this.primsa.campaign.update({
      where: {id},
      data : {
        status: finalStatus,
        ...(finalStatus === 'sent' ? {sentAt: new Date()} : {});
      },
    });

    return {
      campaign: updatedCampaign,
      audienceSize: targetCustomers.length,
      successCount, 
      failureCount
    };
  }
}
