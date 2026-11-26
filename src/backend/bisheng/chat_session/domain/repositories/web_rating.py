from datetime import UTC, datetime

from sqlmodel import select, update

from bisheng.common.errcode.http_error import NotFoundError
from bisheng.company_board.domain.models.feedback import BoardRating
from bisheng.core.database import get_sync_db_session
from bisheng.database.models.message import ChatMessage, LikedType
from bisheng.database.models.session import MessageSession


def save_web_rating(tenant_id, user_id, message_id, rating):
    """Serialize changes to one answer and commit counters and history together."""
    with get_sync_db_session() as session:
        msg = session.exec(
            select(ChatMessage)
            .where(
                ChatMessage.id == message_id,
                ChatMessage.tenant_id == tenant_id,
                ChatMessage.user_id == user_id,
            )
            .with_for_update()
        ).first()
        if msg is None:
            raise NotFoundError.http_exception()
        previous = msg.liked or LikedType.UNRATED.value
        if rating == previous:
            return
        msg.liked = rating
        like = int(rating == LikedType.LIKED.value) - int(previous == LikedType.LIKED.value)
        dislike = int(rating == LikedType.DISLIKED.value) - int(previous == LikedType.DISLIKED.value)
        if msg.chat_id:
            session.exec(
                update(MessageSession)
                .where(
                    MessageSession.tenant_id == tenant_id,
                    MessageSession.chat_id == msg.chat_id,
                )
                .values(like=MessageSession.like + like, dislike=MessageSession.dislike + dislike)
            )
        session.add(
            BoardRating(
                tenant_id=tenant_id,
                user_id=user_id,
                message_id=msg.id,
                rating=rating,
                rated_at=datetime.now(UTC).replace(tzinfo=None),
            )
        )
        session.commit()
