import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import {
  ChatMessageDocument,
  chatMessageToObject,
  ChatMessageModel,
} from './models/message.model';
import { ChatMessage, PaginatedChatMessages } from './models/message.entity';
import { MessageDto, GetMessageDto } from './models/message.dto';
import { ObjectID } from 'mongodb';
import { createRichContent } from './utils/message.helper';
import { MessageGroupedByConversationOutput } from '../conversation/models/messagesFilterInput';

@Injectable()
export class MessageData {
  constructor(
    @InjectModel(ChatMessageModel.name)
    protected chatMessageModel: Model<ChatMessageDocument>,
  ) {}

  async create(
    data: MessageDto,
    senderId: ObjectID,
  ): Promise<ChatMessageModel> {
    const chatMessage = new this.chatMessageModel();
    chatMessage.text = data.text;
    chatMessage.senderId = senderId;
    chatMessage.conversationId = data.conversationId;
    chatMessage.created = new Date();
    chatMessage.deleted = false;

    createRichContent(data, chatMessage);

    const dbResult = await chatMessage.save();
    return chatMessageToObject(dbResult);
  }

  async getMessage(messageId: string): Promise<ChatMessageModel> {
    const message = await this.chatMessageModel.findById(messageId);
    if (!message) throw new Error('Message not found');
    return chatMessageToObject(message);
  }


  async getChatConversationMessages(
    data: GetMessageDto,
  ): Promise<PaginatedChatMessages> {
    let hasMore = false;

    // TODO Min - Max on limit. There is an issue
    // with using a limit of zero as it would return
    // all messages from a conversation
    if (data.limit === 0) data.limit = 40;
    const hasMoreLimit: number = data.limit + 1;

    const query: FilterQuery<ChatMessageDocument> = {
      conversationId: data.conversationId,
    };

    if (data.offsetId) {
      query['_id'] = { $lt: data.offsetId };
    }

    const result: ChatMessageDocument[] = await this.chatMessageModel
      .find(query)
      .limit(hasMoreLimit)
      .sort({
        _id: -1,
      });

    // If the data returned is the same length as the increased limit,
    // we need to ensure we reduce the limit back down to the original
    // limit requested in the api call.
    if (result.length === hasMoreLimit) {
      result.splice(data.limit);
      hasMore = true;
    }

    // We reverse the array here, because to get the correct offset we
    // need to assert that we are getting the last N (limit) messages before
    // the offset in ascending order (oldest message first => newest message).
    // If we didn't do it this way round we would get the first N messages
    // ever created in the dataset
    result.reverse();

    return { messages: result.map(chatMessageToObject), hasMore };
  }

  async updateProperty(
    messageId: ObjectID,
    updateProperty: Record<string, unknown>,
  ): Promise<ChatMessage> {
    const result = await this.chatMessageModel.findOneAndUpdate(
      { _id: messageId },
      updateProperty,
      {
        new: true,
        returnOriginal: false,
      },
    );
    if (!result) throw new Error('Message to update not found');
    return chatMessageToObject(result);
  }

  async delete(messageId: ObjectID): Promise<ChatMessage> {
    return this.updateProperty(messageId, { deleted : true});
  }

  async resolve(messageId: ObjectID): Promise<ChatMessage> {
    return this.updateProperty(messageId, { resolved: true });
  }

  async unresolve(messageId: ObjectID): Promise<ChatMessage> {
    return this.updateProperty(messageId, { resolved: false });
  }

  async like(userId: ObjectID, messageId: ObjectID): Promise<ChatMessage> {
    return this.updateProperty(messageId, { $addToSet: { likes: userId } });
  }

  async unlike(userId: ObjectID, messageId: ObjectID): Promise<ChatMessage> {
    return this.updateProperty(messageId, { $pull: { likes: userId } });
  }

  /**
   * Adds a tag to a message.
   * Confirms the user adding the tag is the sender of the message.
   * @param tag The tag to add
   * @param userId The user adding the tag
   * @param messageId The message to add the tag to
   * @param tagId The id of the tag to add
   * @returns The updated message
   */
  async addTag(tag: string, userId: ObjectID, messageId: ObjectID, tagId : ObjectID = new ObjectID()): Promise<ChatMessage> {
    const updatedResult = await this.chatMessageModel.bulkWrite([
      {
        updateOne: {
          filter: {
            _id: messageId,
            senderId: userId,
          },
          update: {
            $push: {
              tags: {
                _id: tagId,
                tag: tag,
              },
            },
          },
        },
      }
    ]);

    if (!updatedResult || updatedResult.matchedCount === 0) {
      throw new Error(
        `Failed to add tag, messageId: ${messageId.toHexString()}, tag: ${tag}, userId: ${userId.toHexString()}`,
      );
    }

    return this.getMessage(messageId.toHexString());
  }

  async updateTag(tag: string, userId: ObjectID, messageId: ObjectID, tagId: ObjectID): Promise<ChatMessage> {
    const updatedResult = await this.chatMessageModel.bulkWrite([
      {
        updateOne: {
          filter: {
            _id: messageId,
            'tags._id': tagId,
          },
          update: {
            $set: {
              'tags.$.tag': tag,
            },
          },
        },
      }
    ]);

    if (!updatedResult || updatedResult.matchedCount === 0) {
      throw new Error(
        `Failed to update tag, messageId: ${messageId.toHexString()}, tag: ${tag}, userId: ${userId.toHexString()}`,
      );
    }

    return this.getMessage(messageId.toHexString());
  }

  async findMessagesByTags(tags: string[]): Promise<ChatMessage[]> {
    const messages = await this.chatMessageModel.find({
      tags: {
        $elemMatch: {
          tag: {
            $in: tags,
          },
        },
      },
    });
    return messages.map((message) => chatMessageToObject(message));
  }

  async addReaction(
    reaction: string,
    userId: ObjectID,
    reactionUnicode: string,
    messageId: ObjectID,
  ): Promise<ChatMessage> {
    const updatedResult = await this.chatMessageModel.bulkWrite([
      {
        updateOne: {
          filter: {
            _id: messageId,
            reactions: {
              $elemMatch: { reaction: reaction },
            },
          },
          update: {
            $addToSet: { 'reactions.$.userIds': userId },
          },
        },
      },
      {
        updateOne: {
          filter: {
            _id: messageId,
            reactions: {
              $not: {
                $elemMatch: { reaction: reaction },
              },
            },
          },
          update: {
            $push: {
              reactions: {
                reaction: reaction,
                userIds: [userId],
                reactionUnicode: reactionUnicode,
              },
            },
          },
        },
      },
    ]);
    if (!updatedResult || updatedResult.matchedCount === 0) {
      throw new Error(
        `Failed to add reaction, messageId: ${messageId.toHexString()}, reaction: ${reaction}, userId: ${userId.toHexString()}`,
      );
    }

    return this.getMessage(messageId.toHexString());
  }

  async removeReaction(
    reaction: string,
    userId: ObjectID,
    messageId: ObjectID,
  ): Promise<ChatMessage> {
    const updatedResult = await this.chatMessageModel.bulkWrite([
      {
        updateOne: {
          filter: {
            _id: messageId,
            reactions: {
              $elemMatch: { reaction: reaction, userIds: userId },
            },
          },
          update: {
            $pull: { 'reactions.$.userIds': userId },
          },
        },
      },
      {
        updateOne: {
          filter: {
            _id: messageId,
            reactions: {
              $elemMatch: { reaction: reaction, userIds: [] },
            },
          },
          update: {
            $pull: { reactions: { reaction: reaction } },
          },
        },
      },
    ]);

    if (!updatedResult || updatedResult.matchedCount === 0) {
      throw new Error(
        `Failed to remove reaction, messageId: ${messageId.toHexString()}, reaction: ${reaction}, userId: ${userId.toHexString()}`,
      );
    }

    return this.getMessage(messageId.toHexString());
  }

  async getMessages(ids: ObjectID[]): Promise<ChatMessage[]> {
    const chatMessages = await this.chatMessageModel.find({
      _id: { $in: ids },
    });
    return chatMessages.map((chatMessage) => chatMessageToObject(chatMessage));
  }

  async getMessagesGroupedByConversation(
    conversationIds: ObjectID[],
    startDate?: string,
    endDate?: string,
    tags?: string[],
  ): Promise<MessageGroupedByConversationOutput[]> {
    const matchQuery: FilterQuery<ChatMessage> = {
      $match: {
        conversationId: {
          $in: conversationIds,
        },
      },
    };

    if (startDate && endDate) {
      matchQuery['$match']['created'] = {
        $gte: new Date(new Date(startDate).setHours(0, 0, 0, 0)),
        $lte: new Date(new Date(endDate).setHours(23, 59, 59, 999)),
      };
    }
    if (tags) {
      matchQuery['$match']['tags'] = {
        $elemMatch: {
          tag: {
            $in: tags,
          },
        },
      };
    }
    
    const groupedChatMessages = await this.chatMessageModel.aggregate([
      matchQuery,
      {
        $group: {
          _id: '$conversationId',
          messages: {
            $push: {
              senderId: '$senderId',
              message: '$text',
            },
          },
        },
      },
      {
        $project: {
          conversationId: '$_id',
          messages: 1,
        },
      },
    ]);
    return groupedChatMessages;
  }

  async addVote(
    messageId: ObjectID,
    userId: ObjectID,
    option: string,
  ): Promise<ChatMessage> {
    const query = {
      _id: messageId,
      'richContent.poll.options.option': option,
    };
    const updateDocument = {
      $addToSet: { 'richContent.poll.options.$.votes': userId },
    };
    const updatedResult = await this.chatMessageModel.findOneAndUpdate(
      query,
      updateDocument,
      {
        new: true,
        returnOriginal: false,
      },
    );

    if (!updatedResult) {
      throw new Error(
        `Failed to add user: ${userId.toHexString()} to option: ${option} for messageId: ${messageId.toHexString()}`,
      );
    }

    return chatMessageToObject(updatedResult);
  }

  async removeVote(
    messageId: ObjectID,
    userId: ObjectID,
    option: string,
  ): Promise<ChatMessage> {
    const query = {
      _id: messageId,
      'richContent.poll.options.option': option,
    };
    const updateDocument = {
      $pull: { 'richContent.poll.options.$.votes': userId },
    };
    const updatedResult = await this.chatMessageModel.findOneAndUpdate(
      query,
      updateDocument,
      {
        new: true,
        returnOriginal: false,
      },
    );

    if (!updatedResult) {
      throw new Error(
        `Failed to remove user: ${userId.toHexString()} from option: ${option} for messageId: ${messageId.toHexString()}`,
      );
    }

    return chatMessageToObject(updatedResult);
  }
}
